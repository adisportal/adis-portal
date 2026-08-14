const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3000;
const multer = require('multer');
const path = require('path');
const ardosis = require('./ardosis-client');

// Setup storage engine
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function(req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB CLOUD SETUP ---
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

let db;
async function connectToDatabase() {
    try {
        await client.connect();
        db = client.db("ADIS_Portal");
        console.log("🚀 Successfully connected to MongoDB Cloud!");
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
    }
}
connectToDatabase();

let maintenanceMode = false; // Global switch

// --- ID GENERATOR FOR NEW STUDENTS ---
const SCHOOL_EPOCH = 1780000000;
const MACHINE_ID = "1";
let lastTimestamp = -1;
let sequence = 0;
function serverGenerateSnowflake() {
    let currentTimestamp = Math.floor(Date.now() / 1000);
    if (currentTimestamp === lastTimestamp) {
        sequence = (sequence + 1) % 10;
    } else {
        sequence = 0;
        lastTimestamp = currentTimestamp;
    }
    return `${currentTimestamp - SCHOOL_EPOCH}${MACHINE_ID}${sequence}`;
}

// Never expose password hashes to the client, on any route.
const PUBLIC_PROJECTION = { password: 0 };

// --- SCHOOL CODE GENERATOR (for the Owner: create-school flow) ---
function slugifySchoolCode(name) {
    const base = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return base || 'SCH';
}
async function generateUniqueSchoolId(name) {
    const base = slugifySchoolCode(name);
    let candidate = base;
    let attempt = 0;
    while (await db.collection('schools').findOne({ schoolId: candidate })) {
        attempt++;
        candidate = `${base}${Math.floor(10 + Math.random() * 90)}`;
        if (attempt > 20) throw new Error('Could not generate a unique school code');
    }
    return candidate;
}

// A studentId (login id) must be unique across the WHOLE platform, not just
// one school, because login (/api/login, requireAuth) looks a user up by
// studentId alone. This guards against an admin in School A accidentally
// (or deliberately) overwriting/hijacking an id that belongs to School B.
async function idBelongsToSchool(id, role, schoolId) {
    const existing = await db.collection('users').findOne({ studentId: id });
    if (!existing) return true;
    return existing.role === role && existing.schoolId === schoolId;
}

// How long a login session stays valid before the app forces a re-login.
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// =======================================================================
// AUTH MIDDLEWARE
// The client sends its identity via the x-user-id / x-session-id headers
// on every request (set once at login, see authFetch() in script.js).
// This checks that the session exists, matches what's on the user's
// record (single-device guard), and hasn't expired.
// =======================================================================
async function requireAuth(req, res, next) {
    try {
        const userId = req.header('x-user-id');
        const sessionId = req.header('x-session-id');
        if (!userId || !sessionId) {
            return res.status(401).json({ success: false, message: "Not logged in." });
        }
        const user = await db.collection('users').findOne({ studentId: userId });
        if (!user || user.currentSessionId !== sessionId) {
            return res.status(401).json({ success: false, message: "Session expired or logged in elsewhere." });
        }
        if (user.sessionExpiresAt && new Date(user.sessionExpiresAt) < new Date()) {
            return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
        }

        // Sliding expiration: every authenticated request pushes the
        // expiry another SESSION_LIFETIME_MS out, so a session only
        // actually goes stale from real inactivity, not from a fixed
        // clock that started ticking at login. Fire-and-forget — don't
        // add latency/failure risk to the request over a best-effort
        // housekeeping write.
        db.collection('users').updateOne(
            { studentId: userId },
            { $set: { sessionExpiresAt: new Date(Date.now() + SESSION_LIFETIME_MS) } }
        ).catch(e => console.error('Session refresh failed:', e.message));

        req.currentUser = user; // available to downstream handlers
        next();
    } catch (e) {
        res.status(500).json({ success: false, message: "Auth check failed." });
    }
}

// Restricts a route to specific roles, e.g. requireRole('admin')
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.currentUser || !roles.includes(req.currentUser.role)) {
            return res.status(403).json({ success: false, message: "Not authorized for this action." });
        }
        next();
    };
}

// A student/teacher may only act on their own record unless they're admin.
function requireSelfOrRole(paramName, ...roles) {
    return (req, res, next) => {
        if (req.currentUser.role === 'admin' || roles.includes(req.currentUser.role)) return next();
        if (req.currentUser.studentId === req.params[paramName]) return next();
        return res.status(403).json({ success: false, message: "Not authorized for this record." });
    };
}

// Same as requireSelfOrRole, but also lets a parent through for any
// student that's listed in their own linkedStudentIds. Used on the
// read-only student-facing routes (profile, attendance) so a parent can
// view their child's data without being able to touch anyone else's.
function requireSelfOrRoleOrParent(paramName, ...roles) {
    return (req, res, next) => {
        if (req.currentUser.role === 'admin' || roles.includes(req.currentUser.role)) return next();
        if (req.currentUser.studentId === req.params[paramName]) return next();
        if (req.currentUser.role === 'parent' &&
            Array.isArray(req.currentUser.linkedStudentIds) &&
            req.currentUser.linkedStudentIds.includes(req.params[paramName])) {
            return next();
        }
        return res.status(403).json({ success: false, message: "Not authorized for this record." });
    };
}

// Lightweight audit trail for sensitive admin/teacher actions.
async function logAudit(req, action, details = {}) {
    try {
        await db.collection('auditLogs').insertOne({
            action,
            actorId: req.currentUser?.studentId || 'unknown',
            actorRole: req.currentUser?.role || 'unknown',
            schoolId: req.currentUser?.schoolId || null,
            details,
            date: new Date()
        });
    } catch (e) {
        console.error('Audit log failed:', e.message);
    }
}

// Sends a notification to every parent linked to a given studentId (a
// parent may have more than one child, and a child may — in principle —
// have more than one linked parent, so this fans out to all of them).
async function notifyParentsOfStudent(schoolId, studentId, type, message, link = null) {
    try {
        const parents = await db.collection('users').find(
            { role: 'parent', schoolId, linkedStudentIds: studentId },
            { projection: { studentId: 1 } }
        ).toArray();
        if (parents.length === 0) return;
        const docs = parents.map(p => ({
            recipientId: p.studentId,
            schoolId,
            type,
            message,
            link,
            read: false,
            date: new Date()
        }));
        await db.collection('notifications').insertMany(docs);
    } catch (e) {
        console.error('Notification dispatch failed:', e.message);
    }
}

// Sends a notification directly to one user by their login id (used e.g.
// to tell a parent their feedback got a response).
async function notifyUser(schoolId, recipientId, type, message, link = null) {
    try {
        await db.collection('notifications').insertOne({
            recipientId, schoolId, type, message, link, read: false, date: new Date()
        });
    } catch (e) {
        console.error('Notification dispatch failed:', e.message);
    }
}

// =======================================================================
// CHAT — shared helpers (Phase 2C)
// A thread is uniquely identified by (type, sorted participantIds, and
// studentId when the type is teacher-parent — the same two people could
// otherwise collide across two different children).
// =======================================================================
async function findOrCreateThread({ schoolId, type, participantIds, studentId = null }) {
    const sortedParticipants = [...participantIds].sort();
    const query = {
        type,
        participantIds: { $all: sortedParticipants, $size: sortedParticipants.length },
        studentId: studentId || null
    };
    let thread = await db.collection('chatThreads').findOne(query);
    if (!thread) {
        const doc = {
            schoolId, type, participantIds: sortedParticipants,
            studentId: studentId || null,
            createdAt: new Date(),
            lastMessageAt: new Date(),
            lastMessage: null,
            lastMessageSender: null,
            lastReadAt: {}
        };
        const result = await db.collection('chatThreads').insertOne(doc);
        thread = { ...doc, _id: result.insertedId };
    }
    return thread;
}

function isThreadParticipant(thread, userId) {
    return Array.isArray(thread.participantIds) && thread.participantIds.includes(userId);
}

// --- Maintenance mode gate (applies to everything below this point) ---
app.use((req, res, next) => {
    const exempt = req.path === '/api/login' ||
                   req.path === '/api/maintenance/status' ||
                   req.path === '/api/admin/maintenance/toggle';
    if (maintenanceMode && !exempt) {
        return res.status(503).json({
            success: false,
            maintenance: true,
            message: "ADIS Portal is under scheduled maintenance for high-level upgrades. Please check back soon!"
        });
    }
    next();
});

// Owner-only: toggle maintenance mode. This is now a platform-wide switch
// that blocks EVERY school, so it can no longer be left to a single
// school's admin (a per-school pause is a good Phase 2 candidate).
app.post('/api/admin/maintenance/toggle', requireAuth, requireRole('owner'), async (req, res) => {
    const { status } = req.body;
    maintenanceMode = !!status;
    await logAudit(req, 'maintenance_toggle', { status: maintenanceMode });
    console.log(`⚠️ Maintenance Mode: ${maintenanceMode ? 'ON' : 'OFF'}`);
    res.json({ success: true, maintenance: maintenanceMode });
});

app.get('/api/maintenance/status', (req, res) => {
    res.json({ maintenance: maintenanceMode });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// =======================================================================
// LOGIN / SESSION
// =======================================================================
app.post('/api/login', async (req, res) => {
    const { id, password } = req.body;
    try {
        const user = await db.collection('users').findOne({ studentId: id });
        if (user && await bcrypt.compare(password, user.password)) {
            const newSessionId = Date.now().toString() + Math.random().toString(36).slice(2);
            const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

            await db.collection('users').updateOne(
                { studentId: id },
                { $set: { currentSessionId: newSessionId, sessionExpiresAt: expiresAt } }
            );

            // Fire-and-forget — never let an Ardosis hiccup block or fail
            // an actual school login.
            ardosis.syncUser({ studentId: id, name: user.name }).catch(() => {});

            let schoolName = null;
            if (user.schoolId) {
                const school = await db.collection('schools').findOne({ schoolId: user.schoolId });
                schoolName = school ? school.name : null;
            }

            res.json({
                success: true,
                sessionId: newSessionId,
                user: {
                    name: user.name,
                    role: user.role,
                    id: user.studentId,
                    classId: user.classId,
                    schoolId: user.schoolId || null,
                    schoolName: schoolName,
                    performance: user.performance || {}
                }
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get('/api/verify-session', async (req, res) => {
    const { userId, sessionId } = req.query;
    const user = await db.collection('users').findOne({ studentId: userId });
    const valid = !!(user && user.currentSessionId === sessionId &&
        (!user.sessionExpiresAt || new Date(user.sessionExpiresAt) > new Date()));
    res.json({ active: valid });
});

app.post('/api/logout', requireAuth, async (req, res) => {
    await db.collection('users').updateOne(
        { studentId: req.currentUser.studentId },
        { $set: { currentSessionId: null, sessionExpiresAt: null } }
    );
    res.json({ success: true });
});

// =======================================================================
// OWNER: SCHOOLS & ADMINS
// The Owner is the top of the hierarchy — creates schools and the admin
// account for each one. Everything below (teachers/students/etc.) stays
// scoped to a single school via req.currentUser.schoolId.
// =======================================================================
app.post('/api/owner/schools/create', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: "School name is required." });
        }
        const schoolId = await generateUniqueSchoolId(name.trim());
        await db.collection('schools').insertOne({ schoolId, name: name.trim(), createdAt: new Date() });
        await logAudit(req, 'school_create', { schoolId, name: name.trim() });
        res.json({ success: true, message: `School created with code ${schoolId}`, schoolId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/owner/schools', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const schools = await db.collection('schools').find({}).sort({ name: 1 }).toArray();
        const counts = await db.collection('users').aggregate([
            { $match: { role: { $in: ['admin', 'teacher', 'student'] } } },
            { $group: { _id: { schoolId: '$schoolId', role: '$role' }, count: { $sum: 1 } } }
        ]).toArray();
        const withCounts = schools.map(s => {
            const forSchool = counts.filter(c => c._id.schoolId === s.schoolId);
            const get = role => (forSchool.find(c => c._id.role === role) || {}).count || 0;
            return { ...s, adminCount: get('admin'), teacherCount: get('teacher'), studentCount: get('student') };
        });
        res.json(withCounts);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.delete('/api/owner/schools/:schoolId', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const { schoolId } = req.params;
        const userCount = await db.collection('users').countDocuments({ schoolId, role: { $in: ['admin', 'teacher', 'student'] } });
        if (userCount > 0) {
            return res.status(400).json({ success: false, message: `Cannot delete: ${userCount} users still belong to this school. Remove them first.` });
        }
        await db.collection('schools').deleteOne({ schoolId });
        await logAudit(req, 'school_delete', { schoolId });
        res.json({ success: true, message: "School deleted." });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/owner/admins/upsert', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const { id, password, name, schoolId } = req.body;
        if (!id || !name || !schoolId) {
            return res.status(400).json({ success: false, message: "ID, name and schoolId are required." });
        }
        const school = await db.collection('schools').findOne({ schoolId });
        if (!school) return res.status(400).json({ success: false, message: "Unknown schoolId." });

        if (!(await idBelongsToSchool(id, 'admin', schoolId))) {
            return res.status(400).json({ success: false, message: "That ID is already in use by a different user or school." });
        }

        let updateData = { name, role: "admin", schoolId };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "admin" },
            { $set: updateData, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        await logAudit(req, 'admin_upsert', { targetId: id, schoolId });
        res.json({
            success: true,
            message: result.upsertedCount > 0 ? "Admin created successfully" : "Admin updated successfully"
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/owner/admins/:id', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "admin" });
        await logAudit(req, 'admin_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/owner/admins', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const admins = await db.collection('users').find({ role: "admin" }, { projection: PUBLIC_PROJECTION }).sort({ name: 1 }).toArray();
        const schools = await db.collection('schools').find({}).toArray();
        const schoolNameById = Object.fromEntries(schools.map(s => [s.schoolId, s.name]));
        res.json(admins.map(a => ({ ...a, schoolName: schoolNameById[a.schoolId] || 'Unknown' })));
    } catch (e) {
        res.status(500).json([]);
    }
});

app.get('/api/owner/stats', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const [schools, admins, teachers, students] = await Promise.all([
            db.collection('schools').countDocuments({}),
            db.collection('users').countDocuments({ role: 'admin' }),
            db.collection('users').countDocuments({ role: 'teacher' }),
            db.collection('users').countDocuments({ role: 'student' })
        ]);
        res.json({ schools, admins, teachers, students });
    } catch (e) {
        res.status(500).json({ schools: 0, admins: 0, teachers: 0, students: 0 });
    }
});

// Income + growth cards for the Owner Panel (Phase 2C, item 4).
// Income is computed on demand from data that already exists — no schema
// change. Growth relies on the createdAt stamping added earlier in this
// phase, so it will only reflect accounts created from here on; it can't
// retroactively backfill history for older accounts.
app.get('/api/owner/analytics', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const schools = await db.collection('schools').find({}).toArray();
        const students = await db.collection('users').find(
            { role: 'student' }, { projection: { schoolId: 1, feesPaid: 1, totalFees: 1, createdAt: 1 } }
        ).toArray();
        const staffGrowth = await db.collection('users').find(
            { role: { $in: ['teacher', 'parent'] } }, { projection: { role: 1, createdAt: 1 } }
        ).toArray();

        const income = schools.map(s => {
            const schoolStudents = students.filter(st => st.schoolId === s.schoolId);
            const totalFees = schoolStudents.reduce((sum, st) => sum + (st.totalFees || 0), 0);
            const feesPaid = schoolStudents.reduce((sum, st) => sum + (st.feesPaid || 0), 0);
            const collectionPct = totalFees > 0 ? Math.round((feesPaid / totalFees) * 100) : null;
            return { schoolId: s.schoolId, schoolName: s.name, totalFees, feesPaid, collectionPct };
        }).sort((a, b) => b.feesPaid - a.feesPaid);

        const totalIncome = income.reduce((sum, i) => sum + i.feesPaid, 0);
        const totalExpected = income.reduce((sum, i) => sum + i.totalFees, 0);
        const overallCollectionPct = totalExpected > 0 ? Math.round((totalIncome / totalExpected) * 100) : null;

        // Last 6 calendar months, new students/teachers/parents per month.
        const now = new Date();
        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
                key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
                label: d.toLocaleString('default', { month: 'short', year: '2-digit' }),
                students: 0, staff: 0
            });
        }
        const bump = (list, createdAt, field) => {
            if (!createdAt) return;
            const d = new Date(createdAt);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const m = list.find(mo => mo.key === key);
            if (m) m[field]++;
        };
        students.forEach(st => bump(months, st.createdAt, 'students'));
        staffGrowth.forEach(u => bump(months, u.createdAt, 'staff'));

        res.json({ income, totalIncome, totalExpected, overallCollectionPct, growth: months });
    } catch (e) {
        console.error(e);
        res.status(500).json({ income: [], totalIncome: 0, totalExpected: 0, overallCollectionPct: null, growth: [] });
    }
});

// =======================================================================
// ADMIN: TEACHERS
// =======================================================================
app.post('/api/admin/teachers/upsert', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { id, password, name, classId } = req.body;
        if (!id || !name) {
            return res.status(400).json({ success: false, message: "ID and name are required." });
        }
        const schoolId = req.currentUser.schoolId;
        if (!(await idBelongsToSchool(id, 'teacher', schoolId))) {
            return res.status(400).json({ success: false, message: "That ID is already in use by a different user or school." });
        }
        let updateData = { name, classId, role: "teacher", schoolId };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "teacher", schoolId },
            { $set: updateData, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        await logAudit(req, 'teacher_upsert', { targetId: id });
        ardosis.syncUser({ studentId: id, name }).catch(() => {});
        res.json({
            success: true,
            message: result.upsertedCount > 0 ? "Teacher created successfully" : "Teacher updated successfully"
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/admin/teachers/:id', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "teacher", schoolId: req.currentUser.schoolId });
        await logAudit(req, 'teacher_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/teachers', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const teachers = await db.collection('users').find({ role: "teacher", schoolId: req.currentUser.schoolId }, { projection: PUBLIC_PROJECTION }).toArray();
        res.json(teachers);
    } catch (e) {
        res.status(500).json([]);
    }
});

// =======================================================================
// ADMIN: PARENTS
// A parent is a login account (role: 'parent') linked to one or more
// existing students via linkedStudentIds. It carries no classId/fees of
// its own — all of that is read through the linked student record(s).
// =======================================================================
app.post('/api/admin/parents/upsert', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { id, password, name, linkedStudentIds } = req.body;
        const schoolId = req.currentUser.schoolId;
        if (!id || !name || !Array.isArray(linkedStudentIds) || linkedStudentIds.length === 0) {
            return res.status(400).json({ success: false, message: "ID, name and at least one linked student ID are required." });
        }
        if (!(await idBelongsToSchool(id, 'parent', schoolId))) {
            return res.status(400).json({ success: false, message: "That ID is already in use by a different user or school." });
        }
        // Every linked ID must actually be a student in this admin's school.
        const validCount = await db.collection('users').countDocuments({
            studentId: { $in: linkedStudentIds }, role: 'student', schoolId
        });
        if (validCount !== linkedStudentIds.length) {
            return res.status(400).json({ success: false, message: "One or more linked student IDs don't belong to a student in your school." });
        }

        let updateData = { name, role: "parent", schoolId, linkedStudentIds };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "parent", schoolId },
            { $set: updateData, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        await logAudit(req, 'parent_upsert', { targetId: id, linkedStudentIds });
        res.json({
            success: true,
            message: result.upsertedCount > 0 ? "Parent account created successfully" : "Parent account updated successfully"
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/admin/parents/:id', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "parent", schoolId: req.currentUser.schoolId });
        await logAudit(req, 'parent_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/parents', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const parents = await db.collection('users').find(
            { role: "parent", schoolId: req.currentUser.schoolId },
            { projection: PUBLIC_PROJECTION }
        ).sort({ name: 1 }).toArray();
        res.json(parents);
    } catch (e) {
        res.status(500).json([]);
    }
});

// A parent's own view of their linked children's basic info (name,
// class, fees, performance) — reuses the same shape as student/profile
// but returns all linked children in one call.
app.get('/api/parent/children', requireAuth, requireRole('parent'), async (req, res) => {
    try {
        const children = await db.collection('users').find(
            { studentId: { $in: req.currentUser.linkedStudentIds || [] }, role: 'student', schoolId: req.currentUser.schoolId },
            { projection: PUBLIC_PROJECTION }
        ).toArray();
        res.json(children);
    } catch (e) {
        res.status(500).json([]);
    }
});

// =======================================================================
// TEACHER/ADMIN: STUDENTS
// =======================================================================
app.post('/api/teacher/students/upsert', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        let { id, password, name, classId, totalFees } = req.body;
        if (!name || name.trim() === "") {
            return res.status(400).json({ success: false, message: "Student name is required." });
        }
        const schoolId = req.currentUser.schoolId;
        if (!id || String(id).trim() === "") {
            id = serverGenerateSnowflake();
        } else {
            id = String(id).trim();
            if (!(await idBelongsToSchool(id, 'student', schoolId))) {
                return res.status(400).json({ success: false, message: "That ID is already in use by a different user or school." });
            }
        }

        let updateData = {
            name: name,
            classId: classId,
            totalFees: parseFloat(totalFees) || 0,
            role: "student",
            schoolId
        };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        const result = await db.collection('users').updateOne(
            { studentId: id, role: "student", schoolId },
            {
                $set: updateData,
                $setOnInsert: {
                    feesPaid: 0,
                    createdAt: new Date(),
                    performance: { academic: 0, tech: 0, arts: 0, sports: 0, practical: 0, feedback: "Welcome to ADIS!" }
                }
            },
            { upsert: true }
        );

        await logAudit(req, 'student_upsert', { targetId: id });
        ardosis.syncUser({ studentId: id, name }).catch(() => {});

        if (result.upsertedCount > 0) {
            res.json({ success: true, message: `Student created successfully with ID: ${id}`, generatedId: id });
        } else if (result.modifiedCount > 0 || result.matchedCount > 0) {
            res.json({ success: true, message: "Student info updated successfully" });
        } else {
            res.status(400).json({ success: false, message: "No changes made to record" });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error: " + e.message });
    }
});

app.delete('/api/teacher/students/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "student", schoolId: req.currentUser.schoolId });
        await logAudit(req, 'student_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/teacher/students/list', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { role, classId } = req.body;
        let query = { role: "student", schoolId: req.currentUser.schoolId };
        if (role === "teacher") query.classId = classId;
        const students = await db.collection('users').find(query, { projection: PUBLIC_PROJECTION }).sort({ classId: 1, name: 1 }).toArray();
        res.json(students);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.get('/api/students/class/:classId', requireAuth, async (req, res) => {
    try {
        const students = await db.collection('users').find(
            { classId: req.params.classId, role: "student", schoolId: req.currentUser.schoolId },
            { projection: PUBLIC_PROJECTION }
        ).toArray();
        res.json(students);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// =======================================================================
// FEES
// =======================================================================
app.post('/api/fees/update', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentId, amountPaid } = req.body;
        await db.collection('users').updateOne(
            { studentId: studentId, schoolId: req.currentUser.schoolId },
            { $inc: { feesPaid: amountPaid } }
        );
        await logAudit(req, 'fees_update', { targetId: studentId, amountPaid });
        notifyParentsOfStudent(req.currentUser.schoolId, studentId, 'fees', `A payment of ₹${amountPaid} was recorded on your child's fee account.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =======================================================================
// ATTENDANCE
// =======================================================================
app.get('/api/attendance/:classId/:date', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const records = await db.collection('attendance').find({
            classId: req.params.classId,
            date: req.params.date,
            schoolId: req.currentUser.schoolId
        }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/attendance/update', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentId, date, status, classId } = req.body;
        const schoolId = req.currentUser.schoolId;
        await db.collection('attendance').updateOne(
            { studentId: studentId, date: date, schoolId },
            { $set: { status: status, classId: classId, schoolId } },
            { upsert: true }
        );
        await logAudit(req, 'attendance_update', { targetId: studentId, date, status });
        if (status === 'Absent') {
            notifyParentsOfStudent(schoolId, studentId, 'attendance', `Your child was marked absent on ${date}.`);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/student/attendance/:studentId', requireAuth, requireSelfOrRoleOrParent('studentId', 'teacher'), async (req, res) => {
    try {
        const records = await db.collection('attendance').find({
            studentId: req.params.studentId,
            schoolId: req.currentUser.schoolId
        }).sort({ date: -1 }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// =======================================================================
// STUDENT PROFILE
// =======================================================================
app.get('/api/student/profile/:studentId', requireAuth, requireSelfOrRoleOrParent('studentId', 'teacher'), async (req, res) => {
    try {
        const student = await db.collection('users').findOne(
            { studentId: req.params.studentId, schoolId: req.currentUser.schoolId },
            { projection: PUBLIC_PROJECTION }
        );
        res.json(student);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// =======================================================================
// ANNOUNCEMENTS
// =======================================================================
app.post('/api/announcements', requireAuth, requireRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { text, sender, type } = req.body;
        const postData = {
            content: text || "",
            sender: sender || "ADIS Administration",
            type: type || "General",
            imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
            date: new Date(),
            schoolId: req.currentUser.schoolId
        };
        await db.collection('announcements').insertOne(postData);
        await logAudit(req, 'announcement_post', {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/announcements', requireAuth, async (req, res) => {
    try {
        const records = await db.collection('announcements').find({ schoolId: req.currentUser.schoolId }).sort({ date: -1 }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

app.delete('/api/announcements/:id', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        await db.collection('announcements').deleteOne({ _id: new ObjectId(req.params.id), schoolId: req.currentUser.schoolId });
        await logAudit(req, 'announcement_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =======================================================================
// MATERIALS
// =======================================================================
app.post('/api/materials', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const newMaterial = { ...req.body, date: new Date(), schoolId: req.currentUser.schoolId };
        await db.collection('materials').insertOne(newMaterial);
        await logAudit(req, 'material_post', {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/materials/:classId', requireAuth, async (req, res) => {
    try {
        const materials = await db.collection('materials').find({ classId: req.params.classId, schoolId: req.currentUser.schoolId }).sort({ date: -1 }).toArray();
        res.json(materials);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// =======================================================================
// PERFORMANCE
// =======================================================================
app.post('/api/performance/update', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentId, performanceData } = req.body;
        await db.collection('users').updateOne(
            { studentId: studentId, schoolId: req.currentUser.schoolId },
            { $set: { performance: performanceData } }
        );
        await logAudit(req, 'performance_update', { targetId: studentId });
        res.json({ success: true, message: "Performance updated and live for parents!" });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =======================================================================
// ADMIN: CLASSES
// =======================================================================
app.post('/api/admin/classes/create', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { className } = req.body;
        const schoolId = req.currentUser.schoolId;
        const existingClass = await db.collection('classes').findOne({ className, schoolId });
        if (existingClass) {
            return res.status(400).json({ success: false, message: "Class already exists" });
        }
        await db.collection('classes').insertOne({ className, schoolId, createdAt: new Date() });
        await logAudit(req, 'class_create', { className });
        res.json({ success: true, message: "Class created successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/classes', requireAuth, async (req, res) => {
    try {
        const classes = await db.collection('classes').find({ schoolId: req.currentUser.schoolId }).toArray();
        res.json(classes);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.delete('/api/admin/classes/delete/:className', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const className = req.params.className;
        const schoolId = req.currentUser.schoolId;
        const studentsInClass = await db.collection('users').countDocuments({ classId: className, role: "student", schoolId });
        if (studentsInClass > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete class. There are still ${studentsInClass} students in ${className}. Please transfer them first.`
            });
        }
        await db.collection('classes').deleteOne({ className, schoolId });
        await logAudit(req, 'class_delete', { className });
        res.json({ success: true, message: "Class deleted successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/admin/transfer-class', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { fromClass, toClass } = req.body;
        const result = await db.collection('users').updateMany(
            { classId: fromClass, role: "student", schoolId: req.currentUser.schoolId },
            { $set: { classId: toClass } }
        );
        await logAudit(req, 'class_transfer', { fromClass, toClass, count: result.modifiedCount });
        res.json({
            success: true,
            message: `Successfully transferred ${result.modifiedCount} students from ${fromClass} to ${toClass}`
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/admin/users-classwise', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const data = await db.collection('users').aggregate([
            { $match: { role: { $ne: "admin" }, schoolId: req.currentUser.schoolId } },
            { $sort: { classId: 1, name: 1 } },
            {
                $group: {
                    _id: "$classId",
                    users: { $push: { name: "$name", studentId: "$studentId", role: "$role" } }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();
        res.json(data);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.post('/api/admin/overwrite-student', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { targetId, updateFields } = req.body;
        delete updateFields.password; // password changes must go through the upsert route (needs hashing)
        delete updateFields.schoolId; // a school can't be reassigned via this route
        delete updateFields.role;
        await db.collection('users').updateOne(
            { studentId: targetId, schoolId: req.currentUser.schoolId },
            { $set: updateFields }
        );
        await logAudit(req, 'student_overwrite', { targetId, fields: Object.keys(updateFields) });
        res.json({ success: true, message: "Admin Overwrite Complete" });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/active-sessions', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const activeUsers = await db.collection('users')
            .find({ currentSessionId: { $ne: null }, schoolId: req.currentUser.schoolId })
            .project({ name: 1, studentId: 1, role: 1 })
            .toArray();
        res.json(activeUsers);
    } catch (e) {
        res.status(500).json([]);
    }
});

// New: view the audit trail
app.get('/api/admin/audit-log', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const logs = await db.collection('auditLogs').find({ schoolId: req.currentUser.schoolId }).sort({ date: -1 }).limit(200).toArray();
        res.json(logs);
    } catch (e) {
        res.status(500).json([]);
    }
});

// =======================================================================
// FEEDBACK
// Parent -> teacher/admin. Categorized with a status so submissions get
// tracked instead of disappearing into a form nobody looks at.
// =======================================================================
app.post('/api/feedback', requireAuth, requireRole('parent'), async (req, res) => {
    try {
        const { studentId, category, message } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: "Message is required." });
        }
        const linked = req.currentUser.linkedStudentIds || [];
        const targetStudentId = studentId && linked.includes(studentId) ? studentId : linked[0];
        if (!targetStudentId) {
            return res.status(400).json({ success: false, message: "No linked child found on this account." });
        }
        const doc = {
            schoolId: req.currentUser.schoolId,
            studentId: targetStudentId,
            fromId: req.currentUser.studentId,
            fromName: req.currentUser.name,
            category: category || 'General',
            message: message.trim(),
            status: 'open',
            response: null,
            date: new Date(),
            updatedAt: new Date()
        };
        await db.collection('feedback').insertOne(doc);
        await logAudit(req, 'feedback_submit', { studentId: targetStudentId, category: doc.category });
        res.json({ success: true, message: "Feedback submitted." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Admin/teacher: full school feed. Parent: only their own submissions.
app.get('/api/feedback', requireAuth, async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        let query = { schoolId };
        if (req.currentUser.role === 'parent') {
            query.fromId = req.currentUser.studentId;
        } else if (!['admin', 'teacher'].includes(req.currentUser.role)) {
            return res.status(403).json({ success: false, message: "Not authorized." });
        }
        const items = await db.collection('feedback').find(query).sort({ date: -1 }).toArray();
        res.json(items);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.put('/api/feedback/:id/status', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { status, response } = req.body;
        const validStatuses = ['open', 'in_review', 'resolved'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status." });
        }
        const item = await db.collection('feedback').findOne({ _id: new ObjectId(req.params.id), schoolId: req.currentUser.schoolId });
        if (!item) return res.status(404).json({ success: false, message: "Feedback not found." });

        const updateFields = { status, updatedAt: new Date() };
        if (typeof response === 'string' && response.trim()) updateFields.response = response.trim();

        await db.collection('feedback').updateOne(
            { _id: item._id },
            { $set: updateFields }
        );
        await logAudit(req, 'feedback_status_update', { targetId: req.params.id, status });
        notifyUser(item.schoolId, item.fromId, 'feedback', `Your feedback status changed to "${status.replace('_',' ')}".`);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// =======================================================================
// CHAT (Phase 2C)
// Polling-based threads, deliberately not sockets — same reasoning as the
// notifications system: reuses a proven pattern, ships faster, and can be
// swapped for Socket.io later without touching the data model.
//
// Who can talk to whom (enforced in /start below):
//   teacher <-> parent   (scoped to one shared student)
//   admin   <-> teacher  (same school)
//   owner   <-> admin    (any school)
// =======================================================================

// Role-aware address book: who am I allowed to start a new chat with?
app.get('/api/chat/contacts', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        const schoolId = user.schoolId;

        if (user.role === 'teacher') {
            const admins = await db.collection('users').find(
                { role: 'admin', schoolId }, { projection: { name: 1, studentId: 1 } }
            ).toArray();
            const students = await db.collection('users').find(
                { role: 'student', schoolId, classId: user.classId }, { projection: { studentId: 1, name: 1 } }
            ).toArray();
            const studentIds = students.map(s => s.studentId);
            const parents = await db.collection('users').find(
                { role: 'parent', schoolId, linkedStudentIds: { $in: studentIds } },
                { projection: { name: 1, studentId: 1, linkedStudentIds: 1 } }
            ).toArray();
            const parentContacts = [];
            parents.forEach(p => {
                (p.linkedStudentIds || []).filter(sid => studentIds.includes(sid)).forEach(sid => {
                    const student = students.find(s => s.studentId === sid);
                    parentContacts.push({ id: p.studentId, name: p.name, studentId: sid, studentName: student ? student.name : sid });
                });
            });
            return res.json({ admins: admins.map(a => ({ id: a.studentId, name: a.name })), parents: parentContacts });
        }

        if (user.role === 'parent') {
            const students = await db.collection('users').find(
                { studentId: { $in: user.linkedStudentIds || [] }, role: 'student', schoolId },
                { projection: { studentId: 1, name: 1, classId: 1 } }
            ).toArray();
            const contacts = [];
            for (const s of students) {
                const teachers = await db.collection('users').find(
                    { role: 'teacher', schoolId, classId: s.classId }, { projection: { studentId: 1, name: 1 } }
                ).toArray();
                teachers.forEach(t => contacts.push({ id: t.studentId, name: t.name, studentId: s.studentId, studentName: s.name }));
            }
            return res.json({ teachers: contacts });
        }

        if (user.role === 'admin') {
            const teachers = await db.collection('users').find(
                { role: 'teacher', schoolId }, { projection: { studentId: 1, name: 1 } }
            ).toArray();
            const owner = await db.collection('users').findOne({ role: 'owner' }, { projection: { studentId: 1, name: 1 } });
            return res.json({
                teachers: teachers.map(t => ({ id: t.studentId, name: t.name })),
                owner: owner ? { id: owner.studentId, name: owner.name } : null
            });
        }

        if (user.role === 'owner') {
            const admins = await db.collection('users').find(
                { role: 'admin' }, { projection: { studentId: 1, name: 1, schoolId: 1 } }
            ).toArray();
            const schools = await db.collection('schools').find({}).toArray();
            const nameById = Object.fromEntries(schools.map(s => [s.schoolId, s.name]));
            return res.json({
                admins: admins.map(a => ({ id: a.studentId, name: a.name, schoolName: nameById[a.schoolId] || a.schoolId }))
            });
        }

        res.json({});
    } catch (e) {
        console.error(e);
        res.status(500).json({});
    }
});

app.post('/api/chat/threads/start', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        const { otherPartyId, studentId } = req.body;
        if (!otherPartyId) return res.status(400).json({ success: false, message: "otherPartyId is required." });
        if (otherPartyId === user.studentId) return res.status(400).json({ success: false, message: "You can't message yourself." });

        const other = await db.collection('users').findOne({ studentId: otherPartyId });
        if (!other) return res.status(404).json({ success: false, message: "User not found." });

        let type, schoolId, threadStudentId = null;

        if ((user.role === 'teacher' && other.role === 'parent') || (user.role === 'parent' && other.role === 'teacher')) {
            const teacher = user.role === 'teacher' ? user : other;
            const parent = user.role === 'parent' ? user : other;
            if (!studentId) return res.status(400).json({ success: false, message: "studentId is required for a teacher-parent chat." });
            if (!Array.isArray(parent.linkedStudentIds) || !parent.linkedStudentIds.includes(studentId)) {
                return res.status(403).json({ success: false, message: "That parent isn't linked to this student." });
            }
            const student = await db.collection('users').findOne({ studentId, role: 'student' });
            if (!student || student.schoolId !== teacher.schoolId || student.classId !== teacher.classId) {
                return res.status(403).json({ success: false, message: "That teacher doesn't teach this student's class." });
            }
            type = 'teacher-parent'; schoolId = teacher.schoolId; threadStudentId = studentId;
        } else if ((user.role === 'admin' && other.role === 'teacher') || (user.role === 'teacher' && other.role === 'admin')) {
            if (user.schoolId !== other.schoolId) {
                return res.status(403).json({ success: false, message: "That teacher/admin isn't in your school." });
            }
            type = 'admin-teacher'; schoolId = user.schoolId;
        } else if ((user.role === 'owner' && other.role === 'admin') || (user.role === 'admin' && other.role === 'owner')) {
            type = 'owner-admin'; schoolId = other.role === 'admin' ? other.schoolId : user.schoolId;
        } else {
            return res.status(403).json({ success: false, message: "That conversation isn't allowed." });
        }

        const thread = await findOrCreateThread({
            schoolId, type, participantIds: [user.studentId, other.studentId], studentId: threadStudentId
        });
        res.json({ success: true, thread });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// My conversations, enriched with the other party's name and an unread flag.
app.get('/api/chat/threads', requireAuth, async (req, res) => {
    try {
        const userId = req.currentUser.studentId;
        const threads = await db.collection('chatThreads').find({ participantIds: userId }).sort({ lastMessageAt: -1 }).toArray();

        const otherIds = [...new Set(threads.map(t => t.participantIds.find(p => p !== userId)).filter(Boolean))];
        const studentIds = [...new Set(threads.filter(t => t.studentId).map(t => t.studentId))];
        const others = await db.collection('users').find({ studentId: { $in: otherIds } }, { projection: { studentId: 1, name: 1, role: 1 } }).toArray();
        const otherById = Object.fromEntries(others.map(o => [o.studentId, o]));
        const students = await db.collection('users').find({ studentId: { $in: studentIds } }, { projection: { studentId: 1, name: 1 } }).toArray();
        const studentById = Object.fromEntries(students.map(s => [s.studentId, s]));

        const enriched = threads.map(t => {
            const otherId = t.participantIds.find(p => p !== userId);
            const other = otherById[otherId];
            const lastRead = t.lastReadAt && t.lastReadAt[userId] ? new Date(t.lastReadAt[userId]) : null;
            const unread = !!t.lastMessageAt && t.lastMessageSender !== userId && (!lastRead || new Date(t.lastMessageAt) > lastRead);
            return {
                _id: t._id, type: t.type, studentId: t.studentId,
                studentName: t.studentId ? (studentById[t.studentId] ? studentById[t.studentId].name : null) : null,
                otherPartyId: otherId, otherPartyName: other ? other.name : 'Unknown', otherPartyRole: other ? other.role : null,
                lastMessage: t.lastMessage, lastMessageAt: t.lastMessageAt, unread
            };
        });
        res.json(enriched);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.get('/api/chat/threads/:id/messages', requireAuth, async (req, res) => {
    try {
        const thread = await db.collection('chatThreads').findOne({ _id: new ObjectId(req.params.id) });
        if (!thread) return res.status(404).json({ success: false, message: "Thread not found." });
        if (!isThreadParticipant(thread, req.currentUser.studentId)) {
            return res.status(403).json({ success: false, message: "Not a participant in this thread." });
        }
        const messages = await db.collection('chatMessages').find({ threadId: thread._id }).sort({ date: 1 }).toArray();
        await db.collection('chatThreads').updateOne(
            { _id: thread._id },
            { $set: { [`lastReadAt.${req.currentUser.studentId}`]: new Date() } }
        );
        res.json(messages);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.post('/api/chat/threads/:id/messages', requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, message: "Message is required." });

        const thread = await db.collection('chatThreads').findOne({ _id: new ObjectId(req.params.id) });
        if (!thread) return res.status(404).json({ success: false, message: "Thread not found." });
        if (!isThreadParticipant(thread, req.currentUser.studentId)) {
            return res.status(403).json({ success: false, message: "Not a participant in this thread." });
        }

        const doc = {
            threadId: thread._id, schoolId: thread.schoolId,
            senderId: req.currentUser.studentId, senderRole: req.currentUser.role,
            message: message.trim(), date: new Date()
        };
        await db.collection('chatMessages').insertOne(doc);
        await db.collection('chatThreads').updateOne(
            { _id: thread._id },
            {
                $set: {
                    lastMessage: doc.message.slice(0, 140),
                    lastMessageAt: doc.date,
                    lastMessageSender: req.currentUser.studentId,
                    [`lastReadAt.${req.currentUser.studentId}`]: doc.date
                }
            }
        );

        const recipientId = thread.participantIds.find(p => p !== req.currentUser.studentId);
        if (recipientId) {
            notifyUser(thread.schoolId, recipientId, 'chat', `New message from ${req.currentUser.name}.`);
        }
        res.json({ success: true, messageDoc: doc });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// =======================================================================
// OVERSIGHT (Phase 2C — the transparency layer)
// Read access, not write access: a supervisor can see every thread one
// level below them but can't post into a thread they aren't a
// participant in. Same trust model as the rest of the app — admin is
// auto-scoped to their own schoolId, owner is unscoped.
// =======================================================================
app.get('/api/oversight/threads', requireAuth, requireRole('admin', 'owner'), async (req, res) => {
    try {
        const user = req.currentUser;
        const query = { type: { $in: ['teacher-parent', 'admin-teacher'] } };
        if (user.role === 'admin') query.schoolId = user.schoolId;

        const threads = await db.collection('chatThreads').find(query).sort({ lastMessageAt: -1 }).toArray();
        const participantIds = [...new Set(threads.flatMap(t => t.participantIds))];
        const studentIds = [...new Set(threads.filter(t => t.studentId).map(t => t.studentId))];

        const people = await db.collection('users').find({ studentId: { $in: participantIds } }, { projection: { studentId: 1, name: 1, role: 1 } }).toArray();
        const peopleById = Object.fromEntries(people.map(p => [p.studentId, p]));
        const students = await db.collection('users').find({ studentId: { $in: studentIds } }, { projection: { studentId: 1, name: 1 } }).toArray();
        const studentById = Object.fromEntries(students.map(s => [s.studentId, s]));

        let schoolNameById = {};
        if (user.role === 'owner') {
            const schools = await db.collection('schools').find({}).toArray();
            schoolNameById = Object.fromEntries(schools.map(s => [s.schoolId, s.name]));
        }

        const enriched = threads.map(t => ({
            _id: t._id, type: t.type, schoolId: t.schoolId,
            schoolName: schoolNameById[t.schoolId] || undefined,
            studentName: t.studentId ? (studentById[t.studentId] ? studentById[t.studentId].name : null) : null,
            participants: t.participantIds.map(id => ({ id, name: peopleById[id] ? peopleById[id].name : 'Unknown', role: peopleById[id] ? peopleById[id].role : null })),
            lastMessage: t.lastMessage, lastMessageAt: t.lastMessageAt
        }));
        res.json(enriched);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

app.get('/api/oversight/threads/:id/messages', requireAuth, requireRole('admin', 'owner'), async (req, res) => {
    try {
        const thread = await db.collection('chatThreads').findOne({ _id: new ObjectId(req.params.id) });
        if (!thread) return res.status(404).json({ success: false, message: "Thread not found." });
        if (!['teacher-parent', 'admin-teacher'].includes(thread.type)) {
            return res.status(403).json({ success: false, message: "Not within oversight scope." });
        }
        if (req.currentUser.role === 'admin' && thread.schoolId !== req.currentUser.schoolId) {
            return res.status(403).json({ success: false, message: "Not within oversight scope." });
        }
        const messages = await db.collection('chatMessages').find({ threadId: thread._id }).sort({ date: 1 }).toArray();
        await logAudit(req, 'oversight_view', { threadId: req.params.id, type: thread.type });
        res.json(messages);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// =======================================================================
// NOTIFICATIONS
// Targeted, per-recipient records (see notifyParentsOfStudent/notifyUser
// above). Polled by the frontend rather than pushed in real time — a
// WebSocket-based live version is a good next increment once this basic
// version has been used for a while.
// =======================================================================
app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const items = await db.collection('notifications')
            .find({ recipientId: req.currentUser.studentId, schoolId: req.currentUser.schoolId })
            .sort({ date: -1 })
            .limit(50)
            .toArray();
        res.json(items);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/notifications/mark-read', requireAuth, async (req, res) => {
    try {
        const { ids } = req.body; // optional array of specific ids; if omitted, marks all read
        const query = { recipientId: req.currentUser.studentId, schoolId: req.currentUser.schoolId };
        if (Array.isArray(ids) && ids.length > 0) {
            query._id = { $in: ids.map(id => new ObjectId(id)) };
        }
        await db.collection('notifications').updateMany(query, { $set: { read: true } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
