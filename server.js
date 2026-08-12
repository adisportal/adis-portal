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
            { $set: updateData },
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
            { $set: updateData },
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
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/student/attendance/:studentId', requireAuth, requireSelfOrRole('studentId', 'teacher'), async (req, res) => {
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
app.get('/api/student/profile/:studentId', requireAuth, requireSelfOrRole('studentId', 'teacher'), async (req, res) => {
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

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
