const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3000;
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ardosis = require('./ardosis-client');
const PDFDocument = require('pdfkit');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cloudinary = require('cloudinary').v2;

// =======================================================================
// PERSISTENT FILE STORAGE (Phase 5)
// Uploads (announcement images, homework attachments) are held in memory
// by multer, then handed to persistUpload() below. If Cloudinary env vars
// are set, files go there (survive redeploys). Otherwise this falls back
// to the old local-disk behavior, which is fine for local dev but is lost
// on every redeploy on Render's free tier — see roadmap Phase 5 notes.
// =======================================================================
const CLOUDINARY_ENABLED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_ENABLED) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('☁️  Cloudinary persistent storage ENABLED — uploads survive redeploys.');
} else {
    console.log('⚠️  Cloudinary env vars not set — uploads fall back to local disk (lost on redeploy).');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function uploadBufferToCloudinary(buffer, folder) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'auto' }, (err, result) => {
            if (err) return reject(err);
            resolve(result.secure_url);
        });
        stream.end(buffer);
    });
}

// Single entry point every upload route should call. Returns a URL that
// works the same way regardless of which backend actually stored the file.
async function persistUpload(file, folder) {
    if (!file) return null;
    if (CLOUDINARY_ENABLED) {
        return await uploadBufferToCloudinary(file.buffer, folder);
    }
    fs.mkdirSync('./public/uploads/', { recursive: true });
    const filename = `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    fs.writeFileSync(`./public/uploads/${filename}`, file.buffer);
    return `/uploads/${filename}`;
}

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

// One-step onboarding (Phase 4): create a school and its first admin in a
// single call, instead of the two-step create-school-then-pick-from-dropdown
// flow above. That flow still exists for adding more admins to a school
// that already exists.
app.post('/api/owner/onboard', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const { schoolName, adminId, adminName, adminPassword } = req.body;
        if (!schoolName || !schoolName.trim()) {
            return res.status(400).json({ success: false, message: "School name is required." });
        }
        if (!adminId || !adminName || !adminPassword) {
            return res.status(400).json({ success: false, message: "Admin ID, name and password are required." });
        }

        const schoolId = await generateUniqueSchoolId(schoolName.trim());
        await db.collection('schools').insertOne({ schoolId, name: schoolName.trim(), createdAt: new Date() });
        await logAudit(req, 'school_create', { schoolId, name: schoolName.trim() });

        if (!(await idBelongsToSchool(adminId, 'admin', schoolId))) {
            return res.status(400).json({
                success: false,
                message: `School "${schoolName}" was created (code ${schoolId}), but admin ID "${adminId}" is already taken — add the admin separately below.`
            });
        }
        const hashed = await bcrypt.hash(adminPassword, 10);
        await db.collection('users').updateOne(
            { studentId: adminId, role: 'admin' },
            { $set: { name: adminName, role: 'admin', schoolId, password: hashed }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        await logAudit(req, 'admin_upsert', { targetId: adminId, schoolId });
        res.json({ success: true, message: `School "${schoolName}" created (code ${schoolId}) with admin "${adminName}".`, schoolId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Report-card comment bank (Phase 6B): reusable, editable teacher remarks
// instead of retyping fresh comments per student every exam cycle.
app.post('/api/report-cards/comment-bank', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ success: false, message: "Comment text is required." });
        await db.collection('reportCardComments').insertOne({ schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId, text: text.trim(), createdAt: new Date() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});
app.get('/api/report-cards/comment-bank', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const comments = await db.collection('reportCardComments').find({ schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId }).sort({ createdAt: -1 }).toArray();
        res.json(comments);
    } catch (e) {
        res.status(500).json([]);
    }
});
app.delete('/api/report-cards/comment-bank/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        await db.collection('reportCardComments').deleteOne({ _id: new ObjectId(req.params.id), teacherId: req.currentUser.studentId });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Quick-reply chat messages (Phase 6B): teacher-side canned messages
// insertable into the chat composer instead of retyping common notes.
app.post('/api/chat/quick-replies', requireAuth, requireRole('teacher'), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ success: false, message: "Message text is required." });
        await db.collection('chatQuickReplies').insertOne({ schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId, text: text.trim(), createdAt: new Date() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});
app.get('/api/chat/quick-replies', requireAuth, requireRole('teacher'), async (req, res) => {
    try {
        const defaults = ['Homework reminder for tonight.', 'A quick note about attendance — please contact the school.', 'Excellent work this week!', 'Could you please contact the school office?', 'Requesting a parent-teacher meeting — please let us know your availability.'];
        const saved = await db.collection('chatQuickReplies').find({ schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId }).sort({ createdAt: -1 }).toArray();
        res.json({ defaults, saved });
    } catch (e) {
        res.status(500).json({ defaults: [], saved: [] });
    }
});
app.delete('/api/chat/quick-replies/:id', requireAuth, requireRole('teacher'), async (req, res) => {
    try {
        await db.collection('chatQuickReplies').deleteOne({ _id: new ObjectId(req.params.id), teacherId: req.currentUser.studentId });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =======================================================================
// GLOBAL SEARCH (Phase 6A) — admin-facing: search students/teachers/classes
// by name or ID, get a compact result card without menu navigation.
// =======================================================================
app.get('/api/admin/search', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ students: [], teachers: [], classes: [] });
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const studentDocs = await db.collection('users').find(
            { schoolId, role: 'student', $or: [{ name: re }, { studentId: re }] },
            { projection: PUBLIC_PROJECTION }
        ).limit(8).toArray();

        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const students = [];
        for (const s of studentDocs) {
            const records = await db.collection('attendance').find({ studentId: s.studentId, schoolId, date: { $gte: cutoffStr } }).toArray();
            const present = records.filter(r => r.status === 'Present').length;
            const attendancePct = records.length ? Math.round((present / records.length) * 100) : null;

            const homeworkDocs = await db.collection('homework').find({ schoolId, classId: s.classId }).sort({ createdAt: -1 }).limit(15).toArray();
            const statuses = await db.collection('homeworkStatus').find({ studentId: s.studentId, homeworkId: { $in: homeworkDocs.map(h => String(h._id)) } }).toArray();
            const doneCount = statuses.filter(st => st.done).length;

            const latestExam = await db.collection('examConfigs').find({ schoolId, classId: s.classId }).sort({ createdAt: -1 }).limit(1).toArray();
            let reportCardStatus = null;
            if (latestExam.length) {
                const mark = await db.collection('examMarks').findOne({ schoolId, classId: s.classId, examName: latestExam[0].examName, studentId: s.studentId });
                reportCardStatus = { examName: latestExam[0].examName, status: latestExam[0].status, released: !!(mark && mark.released) };
            }

            students.push({
                studentId: s.studentId, name: s.name, classId: s.classId,
                attendancePct,
                homeworkDone: doneCount, homeworkTotal: homeworkDocs.length,
                feesOutstanding: Math.max((s.totalFees || 0) - (s.feesPaid || 0), 0),
                reportCardStatus
            });
        }

        const teachers = await db.collection('users').find(
            { schoolId, role: 'teacher', $or: [{ name: re }, { studentId: re }] },
            { projection: { studentId: 1, name: 1, classId: 1 } }
        ).limit(8).toArray();

        const classes = await db.collection('classes').find({ schoolId, className: re }).limit(8).toArray();

        res.json({ students, teachers, classes: classes.map(c => c.className) });
    } catch (e) {
        console.error('[admin/search]', e);
        res.status(500).json({ students: [], teachers: [], classes: [] });
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
// Bulk actions on the Student Directory (Phase 6B) — deliberately scoped
// to $set-only field updates rather than reusing the full upsert route,
// so a bulk class change can't accidentally wipe fee/parent fields the
// bulk form never touched.
app.post('/api/admin/students/bulk-class-change', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentIds, newClassId } = req.body;
        if (!Array.isArray(studentIds) || studentIds.length === 0 || !newClassId) {
            return res.status(400).json({ success: false, message: "Select at least one student and a target class." });
        }
        const result = await db.collection('users').updateMany(
            { studentId: { $in: studentIds }, role: 'student', schoolId: req.currentUser.schoolId },
            { $set: { classId: newClassId } }
        );
        await logAudit(req, 'bulk_class_change', { count: result.modifiedCount, newClassId });
        res.json({ success: true, updated: result.modifiedCount });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/admin/students/bulk-notify-parents', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentIds, message } = req.body;
        if (!Array.isArray(studentIds) || studentIds.length === 0 || !message || !message.trim()) {
            return res.status(400).json({ success: false, message: "Select at least one student and enter a message." });
        }
        for (const sid of studentIds) {
            await notifyParentsOfStudent(req.currentUser.schoolId, sid, 'academic', message.trim());
        }
        await logAudit(req, 'bulk_notify_parents', { count: studentIds.length });
        res.json({ success: true, notified: studentIds.length });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/teacher/students/upsert', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        let { id, password, name, classId, totalFees, feeDueDate, fatherName, motherName, dob } = req.body;
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
        if (feeDueDate) updateData.feeDueDate = feeDueDate;
        if (fatherName !== undefined) updateData.fatherName = fatherName;
        if (motherName !== undefined) updateData.motherName = motherName;
        if (dob !== undefined) updateData.dob = dob;
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
        // Logged separately from the cumulative feesPaid counter so the
        // Activity Timeline (Phase 6B) has individual payment events to show,
        // not just a running total.
        await db.collection('feePayments').insertOne({
            schoolId: req.currentUser.schoolId, studentId, amountPaid,
            recordedBy: req.currentUser.studentId, recordedByName: req.currentUser.name, date: new Date()
        });
        await logAudit(req, 'fees_update', { targetId: studentId, amountPaid });
        notifyParentsOfStudent(req.currentUser.schoolId, studentId, 'fees', `A payment of ₹${amountPaid} was recorded on your child's fee account.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Fee due-dates + reminders (Phase 3). No real cron here — Render's free
// tier sleeps on idle, so a scheduled job wouldn't fire reliably anyway.
// Instead this is admin-triggered from the Fees screen (single student or
// bulk "remind all overdue"), reusing the existing notification system.
app.post('/api/admin/fees/set-due-date', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { studentId, feeDueDate } = req.body;
        if (!studentId) return res.status(400).json({ success: false, message: "studentId is required." });
        const result = await db.collection('users').updateOne(
            { studentId, role: 'student', schoolId: req.currentUser.schoolId },
            feeDueDate ? { $set: { feeDueDate } } : { $unset: { feeDueDate: "" } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "Student not found." });
        await logAudit(req, 'fee_due_date_set', { targetId: studentId, feeDueDate: feeDueDate || null });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Students with an outstanding balance and a due date within the next 3
// days (or already past). "Due soon" as well as overdue so admins can
// get ahead of it, not just chase after the fact.
app.get('/api/admin/fees/overdue', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + 3);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const students = await db.collection('users').find(
            { role: 'student', schoolId, feeDueDate: { $exists: true, $ne: null, $lte: cutoffStr } },
            { projection: { studentId: 1, name: 1, classId: 1, totalFees: 1, feesPaid: 1, feeDueDate: 1, lastFeeReminderAt: 1 } }
        ).sort({ feeDueDate: 1 }).toArray();

        const today = new Date().toISOString().slice(0, 10);
        const overdue = students
            .filter(s => (s.totalFees || 0) - (s.feesPaid || 0) > 0)
            .map(s => ({
                studentId: s.studentId, name: s.name, classId: s.classId,
                remaining: (s.totalFees || 0) - (s.feesPaid || 0),
                feeDueDate: s.feeDueDate,
                isOverdue: s.feeDueDate < today,
                lastFeeReminderAt: s.lastFeeReminderAt || null
            }));
        res.json(overdue);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

const FEE_REMINDER_COOLDOWN_HOURS = 24;

async function sendFeeReminder(schoolId, student) {
    const now = new Date();
    if (student.lastFeeReminderAt) {
        const hoursSince = (now - new Date(student.lastFeeReminderAt)) / (1000 * 60 * 60);
        if (hoursSince < FEE_REMINDER_COOLDOWN_HOURS) return false;
    }
    const remaining = (student.totalFees || 0) - (student.feesPaid || 0);
    const dueLabel = student.feeDueDate < now.toISOString().slice(0, 10) ? 'was due on' : 'is due on';
    notifyParentsOfStudent(schoolId, student.studentId, 'fees',
        `Fee reminder: ₹${remaining} for ${student.name} ${dueLabel} ${student.feeDueDate}.`);
    await db.collection('users').updateOne({ studentId: student.studentId, schoolId }, { $set: { lastFeeReminderAt: now } });
    return true;
}

app.post('/api/admin/fees/remind/:studentId', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const student = await db.collection('users').findOne(
            { studentId: req.params.studentId, role: 'student', schoolId },
            { projection: { studentId: 1, name: 1, totalFees: 1, feesPaid: 1, feeDueDate: 1, lastFeeReminderAt: 1 } }
        );
        if (!student || !student.feeDueDate) return res.status(404).json({ success: false, message: "Student or due date not found." });
        const sent = await sendFeeReminder(schoolId, student);
        await logAudit(req, 'fee_reminder_sent', { targetId: student.studentId, sent });
        res.json({ success: true, sent, message: sent ? "Reminder sent." : "A reminder was already sent recently — skipped to avoid spamming." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/admin/fees/remind-all', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + 3);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const students = await db.collection('users').find(
            { role: 'student', schoolId, feeDueDate: { $exists: true, $ne: null, $lte: cutoffStr } },
            { projection: { studentId: 1, name: 1, totalFees: 1, feesPaid: 1, feeDueDate: 1, lastFeeReminderAt: 1 } }
        ).toArray();
        const overdue = students.filter(s => (s.totalFees || 0) - (s.feesPaid || 0) > 0);

        let sentCount = 0, skippedCount = 0;
        for (const s of overdue) {
            const sent = await sendFeeReminder(schoolId, s);
            if (sent) sentCount++; else skippedCount++;
        }
        await logAudit(req, 'fee_reminder_bulk_sent', { sentCount, skippedCount });
        res.json({ success: true, sentCount, skippedCount });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// =======================================================================
// TIMETABLE (Phase 3)
// One document per scheduled period: { schoolId, classId, day, period,
// startTime, endTime, subject, teacherId }. A teacher's "my schedule"
// aggregates across every class they're assigned to teach, since a
// teacher can hold a subject slot in a class that isn't their own
// homeroom classId.
// =======================================================================
const TIMETABLE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

app.post('/api/admin/timetable/slot', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        let { classId, day, period, startTime, endTime, subject, teacherId } = req.body;
        if (!classId || !day || !period || !subject || !subject.trim()) {
            return res.status(400).json({ success: false, message: "Class, day, period, and subject are required." });
        }
        if (!TIMETABLE_DAYS.includes(day)) {
            return res.status(400).json({ success: false, message: "Invalid day." });
        }
        period = parseInt(period);
        if (teacherId) {
            const teacher = await db.collection('users').findOne({ studentId: teacherId, role: 'teacher', schoolId });
            if (!teacher) return res.status(400).json({ success: false, message: "Teacher not found in your school." });
        }
        const clash = await db.collection('timetableSlots').findOne({ schoolId, classId, day, period });
        if (clash) return res.status(400).json({ success: false, message: `Period ${period} on ${day} is already scheduled for this class.` });

        const doc = {
            schoolId, classId, day, period,
            startTime: startTime || '', endTime: endTime || '',
            subject: subject.trim(), teacherId: teacherId || null,
            createdAt: new Date()
        };
        const result = await db.collection('timetableSlots').insertOne(doc);
        await logAudit(req, 'timetable_slot_create', { classId, day, period, subject: doc.subject });
        res.json({ success: true, slot: { ...doc, _id: result.insertedId } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/admin/timetable/slot/:id', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.collection('timetableSlots').deleteOne({ _id: new ObjectId(req.params.id), schoolId: req.currentUser.schoolId });
        await logAudit(req, 'timetable_slot_delete', { id: req.params.id });
        res.json({ success: result.deletedCount > 0 });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

async function enrichTimetableSlots(slots) {
    const teacherIds = [...new Set(slots.filter(s => s.teacherId).map(s => s.teacherId))];
    const teachers = await db.collection('users').find({ studentId: { $in: teacherIds } }, { projection: { studentId: 1, name: 1 } }).toArray();
    const teacherById = Object.fromEntries(teachers.map(t => [t.studentId, t]));
    return slots
        .map(s => ({ ...s, teacherName: s.teacherId ? (teacherById[s.teacherId] ? teacherById[s.teacherId].name : 'Unknown') : null }))
        .sort((a, b) => TIMETABLE_DAYS.indexOf(a.day) - TIMETABLE_DAYS.indexOf(b.day) || a.period - b.period);
}

app.get('/api/timetable/class/:classId', requireAuth, async (req, res) => {
    try {
        const slots = await db.collection('timetableSlots').find({ schoolId: req.currentUser.schoolId, classId: req.params.classId }).toArray();
        res.json(await enrichTimetableSlots(slots));
    } catch (e) {
        res.status(500).json([]);
    }
});

// Role-aware "my schedule": teacher gets every slot they're assigned to
// teach across classes, student gets their own class's timetable, parent
// needs ?studentId= to pick which child.
app.get('/api/timetable/mine', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        let query = { schoolId: user.schoolId };
        if (user.role === 'teacher') {
            query.teacherId = user.studentId;
        } else if (user.role === 'student') {
            query.classId = user.classId;
        } else if (user.role === 'parent') {
            const studentId = req.query.studentId;
            if (!studentId || !Array.isArray(user.linkedStudentIds) || !user.linkedStudentIds.includes(studentId)) {
                return res.status(403).json({ success: false, message: "Not linked to this student." });
            }
            const student = await db.collection('users').findOne({ studentId, role: 'student', schoolId: user.schoolId });
            if (!student) return res.json([]);
            query.classId = student.classId;
        } else {
            return res.json([]);
        }
        const slots = await db.collection('timetableSlots').find(query).toArray();
        res.json(await enrichTimetableSlots(slots));
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// =======================================================================
// HOME DASHBOARD (Phase 6A)
// One role-aware summary endpoint powering the new "Home" dashboard that
// replaces the old generic Announcements landing page. Built entirely on
// existing collections (attendance, homework, homeworkStatus,
// timetableSlots, feedback, chatThreads, users) — no new schema, same
// pattern used for the owner analytics cards back in Phase 2C.
// =======================================================================
async function countUnreadThreads(userId) {
    const threads = await db.collection('chatThreads').find(
        { participantIds: userId },
        { projection: { lastMessageAt: 1, lastMessageSender: 1, lastReadAt: 1 } }
    ).toArray();
    return threads.filter(t => {
        const lastRead = t.lastReadAt && t.lastReadAt[userId] ? new Date(t.lastReadAt[userId]) : null;
        return !!t.lastMessageAt && t.lastMessageSender !== userId && (!lastRead || new Date(t.lastMessageAt) > lastRead);
    }).length;
}

function todayDayCode() {
    // JS getDay(): 0=Sun..6=Sat. TIMETABLE_DAYS only covers Mon-Sat (no school Sunday).
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        const schoolId = user.schoolId;
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayDay = todayDayCode();
        const nowHM = new Date().toTimeString().slice(0, 5);

        if (user.role === 'teacher') {
            const slotsToday = (await db.collection('timetableSlots').find({ schoolId, teacherId: user.studentId, day: todayDay }).toArray())
                .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            const nextPeriod = slotsToday.find(s => (s.startTime || '') >= nowHM) || null;

            const classIdsToday = [...new Set(slotsToday.map(s => s.classId))];
            const attendanceStatus = [];
            for (const classId of classIdsToday) {
                const marked = await db.collection('attendance').countDocuments({ schoolId, classId, date: todayStr });
                const roster = await db.collection('users').countDocuments({ schoolId, role: 'student', classId });
                attendanceStatus.push({ classId, taken: marked > 0, marked, roster });
            }

            const homeworkDocs = await db.collection('homework').find({ schoolId, teacherId: user.studentId }).sort({ createdAt: -1 }).limit(20).toArray();
            const now = new Date();
            const dueSoon = homeworkDocs.filter(h => h.dueDate && new Date(h.dueDate) >= now && (new Date(h.dueDate) - now) < 4 * 24 * 3600 * 1000);
            const homeworkDueSoon = [];
            for (const h of dueSoon.slice(0, 5)) {
                const roster = await db.collection('users').countDocuments({ schoolId, role: 'student', classId: h.classId });
                const done = await db.collection('homeworkStatus').countDocuments({ homeworkId: String(h._id), done: true });
                homeworkDueSoon.push({ title: h.title, classId: h.classId, dueDate: h.dueDate, doneCount: done, totalCount: roster });
            }

            return res.json({
                role: 'teacher',
                nextPeriod: nextPeriod ? { subject: nextPeriod.subject, classId: nextPeriod.classId, startTime: nextPeriod.startTime, endTime: nextPeriod.endTime } : null,
                attendanceStatus,
                homeworkDueSoon,
                unreadMessages: await countUnreadThreads(user.studentId)
            });
        }

        if (user.role === 'student') {
            const slotsToday = (await db.collection('timetableSlots').find({ schoolId, classId: user.classId, day: todayDay }).toArray())
                .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            const nextPeriod = slotsToday.find(s => (s.startTime || '') >= nowHM) || null;

            const homeworkDocs = await db.collection('homework').find({ schoolId, classId: user.classId }).sort({ createdAt: -1 }).limit(20).toArray();
            const statuses = await db.collection('homeworkStatus').find({ studentId: user.studentId, homeworkId: { $in: homeworkDocs.map(h => String(h._id)) } }).toArray();
            const doneIds = new Set(statuses.filter(s => s.done).map(s => s.homeworkId));
            const now = new Date();
            const homeworkPending = homeworkDocs
                .filter(h => !doneIds.has(String(h._id)))
                .map(h => ({ title: h.title, classId: h.classId, dueDate: h.dueDate, overdue: !!h.dueDate && new Date(h.dueDate) < now }))
                .slice(0, 6);

            return res.json({
                role: 'student',
                nextPeriod: nextPeriod ? { subject: nextPeriod.subject, startTime: nextPeriod.startTime, endTime: nextPeriod.endTime } : null,
                homeworkPending,
                unreadMessages: await countUnreadThreads(user.studentId)
            });
        }

        if (user.role === 'parent') {
            const linkedIds = user.linkedStudentIds || [];
            const children = await db.collection('users').find({ studentId: { $in: linkedIds }, role: 'student', schoolId }, { projection: PUBLIC_PROJECTION }).toArray();
            const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
            const cutoffStr = cutoff.toISOString().slice(0, 10);

            const children_summary = [];
            for (const child of children) {
                const records = await db.collection('attendance').find({ studentId: child.studentId, schoolId, date: { $gte: cutoffStr } }).toArray();
                const present = records.filter(r => r.status === 'Present').length;
                const attendancePct = records.length ? Math.round((present / records.length) * 100) : null;

                const homeworkDocs = await db.collection('homework').find({ schoolId, classId: child.classId }).sort({ createdAt: -1 }).limit(15).toArray();
                const statuses = await db.collection('homeworkStatus').find({ studentId: child.studentId, homeworkId: { $in: homeworkDocs.map(h => String(h._id)) } }).toArray();
                const doneCount = statuses.filter(s => s.done).length;

                children_summary.push({
                    studentId: child.studentId,
                    name: child.name,
                    classId: child.classId,
                    attendancePct,
                    homeworkDone: doneCount,
                    homeworkTotal: homeworkDocs.length,
                    feesOutstanding: Math.max((child.totalFees || 0) - (child.feesPaid || 0), 0)
                });
            }
            return res.json({ role: 'parent', children: children_summary, unreadMessages: await countUnreadThreads(user.studentId) });
        }

        if (user.role === 'admin') {
            const classes = await db.collection('classes').find({ schoolId }).toArray();
            let classesNoAttendance = 0;
            for (const c of classes) {
                const marked = await db.collection('attendance').countDocuments({ schoolId, classId: c.className, date: todayStr });
                if (marked === 0) classesNoAttendance++;
            }

            const overdueHomework = await db.collection('homework').countDocuments({ schoolId, dueDate: { $ne: null, $lt: todayStr } });

            const students = await db.collection('users').find({ schoolId, role: 'student' }, { projection: { totalFees: 1, feesPaid: 1 } }).toArray();
            const feesOutstanding = students.reduce((sum, s) => sum + Math.max((s.totalFees || 0) - (s.feesPaid || 0), 0), 0);

            const unresolvedFeedback = await db.collection('feedback').countDocuments({ schoolId, status: { $ne: 'resolved' } });

            return res.json({
                role: 'admin',
                classesTotal: classes.length,
                classesNoAttendance,
                overdueHomework,
                feesOutstanding,
                unresolvedFeedback
            });
        }

        res.json({ role: user.role });
    } catch (e) {
        console.error('[dashboard/summary]', e);
        res.status(500).json({ error: "Database error" });
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

// Homework + marks + activity timeline for one specific student, powering
// the redesigned Student Profile (Phase 6A). Same self/parent/teacher/admin
// access rule as the attendance route above.
app.get('/api/student/homework/:studentId', requireAuth, requireSelfOrRoleOrParent('studentId', 'teacher'), async (req, res) => {
    try {
        const student = await db.collection('users').findOne({ studentId: req.params.studentId, schoolId: req.currentUser.schoolId });
        if (!student) return res.json([]);
        const items = await db.collection('homework').find({ classId: student.classId, schoolId: req.currentUser.schoolId }).sort({ createdAt: -1 }).toArray();
        res.json(await enrichHomeworkForStudent(items, req.params.studentId));
    } catch (e) {
        res.status(500).json([]);
    }
});

app.get('/api/student/marks/:studentId', requireAuth, requireSelfOrRoleOrParent('studentId', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const studentId = req.params.studentId;
        const student = await db.collection('users').findOne({ studentId, schoolId });
        if (!student) return res.json([]);
        const isStaff = ['admin', 'teacher'].includes(req.currentUser.role);

        const configs = await db.collection('examConfigs').find({ schoolId, classId: student.classId }).sort({ createdAt: -1 }).toArray();
        const rows = [];
        for (const cfg of configs) {
            const mark = await db.collection('examMarks').findOne({ schoolId, classId: student.classId, examName: cfg.examName, studentId });
            if (!mark) continue;
            if (!isStaff && !mark.released) continue; // self/parent only see released cards
            rows.push({
                examName: cfg.examName, status: cfg.status, released: !!mark.released,
                percentage: mark.percentage || 0, overallMarks: mark.overallMarks || 0, overallTotal: mark.overallTotal || 0, rank: mark.rank || null
            });
        }
        res.json(rows);
    } catch (e) {
        res.status(500).json([]);
    }
});

// Chronological activity feed (Phase 6B) — attendance, homework
// submissions, fee payments, report card verifications, all built from
// data those modules already write, no new schema beyond feePayments.
app.get('/api/student/timeline/:studentId', requireAuth, requireSelfOrRoleOrParent('studentId', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const studentId = req.params.studentId;
        const student = await db.collection('users').findOne({ studentId, schoolId });
        if (!student) return res.json([]);

        const events = [];

        const attendance = await db.collection('attendance').find({ studentId, schoolId }).sort({ date: -1 }).limit(10).toArray();
        attendance.forEach(a => events.push({ date: new Date(a.date), icon: a.status === 'Present' ? '🟢' : '🔴', text: `Attendance marked ${a.status}` }));

        const homeworkDocs = await db.collection('homework').find({ classId: student.classId, schoolId }).toArray();
        const hwIds = homeworkDocs.map(h => String(h._id));
        const hwById = Object.fromEntries(homeworkDocs.map(h => [String(h._id), h]));
        const statuses = await db.collection('homeworkStatus').find({ studentId, homeworkId: { $in: hwIds }, done: true }).sort({ doneAt: -1 }).limit(10).toArray();
        statuses.forEach(s => events.push({ date: new Date(s.doneAt), icon: '📚', text: `Homework submitted: "${hwById[s.homeworkId] ? hwById[s.homeworkId].title : 'Unknown'}"` }));

        const payments = await db.collection('feePayments').find({ studentId, schoolId }).sort({ date: -1 }).limit(10).toArray();
        payments.forEach(p => events.push({ date: new Date(p.date), icon: '💰', text: `Fee payment recorded: ₹${p.amountPaid}` }));

        const verifiedExams = await db.collection('examConfigs').find({ classId: student.classId, schoolId, status: 'verified' }).sort({ verifiedAt: -1 }).limit(5).toArray();
        verifiedExams.forEach(e => events.push({ date: new Date(e.verifiedAt || e.updatedAt), icon: '✅', text: `Report card verified: ${e.examName}` }));

        events.sort((a, b) => b.date - a.date);
        res.json(events.slice(0, 25));
    } catch (e) {
        console.error('[student/timeline]', e);
        res.status(500).json([]);
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
            imageUrl: await persistUpload(req.file, 'announcements'),
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

// Owner sees the audit trail across every school (optionally filtered to
// one via ?schoolId=), mirroring the admin version above.
app.get('/api/owner/audit-log', requireAuth, requireRole('owner'), async (req, res) => {
    try {
        const query = {};
        if (req.query.schoolId) query.schoolId = req.query.schoolId;
        const logs = await db.collection('auditLogs').find(query).sort({ date: -1 }).limit(300).toArray();
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
// Small helper for the "Message Parent" contextual action on a Student
// Profile (Phase 6B) — resolves which parent account to open/start a
// thread with, since the profile only knows the student's id.
app.get('/api/chat/parent-for-student/:studentId', requireAuth, requireRole('teacher'), async (req, res) => {
    try {
        const student = await db.collection('users').findOne({ studentId: req.params.studentId, role: 'student', schoolId: req.currentUser.schoolId });
        if (!student || student.classId !== req.currentUser.classId) {
            return res.status(403).json({ success: false, message: "You don't teach this student's class." });
        }
        const parent = await db.collection('users').findOne({ role: 'parent', schoolId: req.currentUser.schoolId, linkedStudentIds: req.params.studentId });
        if (!parent) return res.status(404).json({ success: false, message: "No parent account is linked to this student yet." });
        res.json({ success: true, parentId: parent.studentId });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

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
            emitChatMessage(recipientId, thread._id, doc);
        }
        // Also push to the sender's own other open tabs/devices so a second
        // window doesn't have to wait on the poll to show its own message.
        emitChatMessage(req.currentUser.studentId, thread._id, doc);
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

// =======================================================================
// HOMEWORK / ASSIGNMENTS (Phase 3)
// One document per assignment posted by a teacher for a class. Per-student
// completion is tracked separately (homeworkStatus) so a checklist can be
// rendered for the student/parent view without bloating the homework doc.
// =======================================================================
async function notifyParentsOfClass(schoolId, classId, type, message) {
    try {
        const students = await db.collection('users').find(
            { role: 'student', schoolId, classId }, { projection: { studentId: 1 } }
        ).toArray();
        for (const s of students) {
            await notifyParentsOfStudent(schoolId, s.studentId, type, message);
            await notifyUser(schoolId, s.studentId, type, message);
        }
    } catch (e) {
        console.error('Class notify failed:', e.message);
    }
}

// Homework templates (Phase 6B): teachers save a title+description as a
// reusable template and duplicate-with-new-date instead of retyping
// weekly assignments.
app.post('/api/homework/templates', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, message: "Title is required." });
        const doc = { schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId, title: title.trim(), description: description || '', createdAt: new Date() };
        await db.collection('homeworkTemplates').insertOne(doc);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/homework/templates', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const templates = await db.collection('homeworkTemplates').find({ schoolId: req.currentUser.schoolId, teacherId: req.currentUser.studentId }).sort({ createdAt: -1 }).toArray();
        res.json(templates);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.delete('/api/homework/templates/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        await db.collection('homeworkTemplates').deleteOne({ _id: new ObjectId(req.params.id), teacherId: req.currentUser.studentId });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/homework', requireAuth, requireRole('admin', 'teacher'), upload.single('attachment'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, title, description, dueDate } = req.body;
        if (!classId || !title || !title.trim()) {
            return res.status(400).json({ success: false, message: "Class and title are required." });
        }
        const doc = {
            schoolId, classId,
            teacherId: req.currentUser.studentId,
            teacherName: req.currentUser.name,
            title: title.trim(),
            description: description || '',
            dueDate: dueDate || null,
            attachmentUrl: await persistUpload(req.file, 'homework'),
            createdAt: new Date()
        };
        const result = await db.collection('homework').insertOne(doc);
        await logAudit(req, 'homework_post', { classId, title: doc.title });
        notifyParentsOfClass(schoolId, classId, 'homework', `New homework posted for ${classId}: "${doc.title}"${dueDate ? ' (due ' + dueDate + ')' : ''}.`);
        res.json({ success: true, homework: { ...doc, _id: result.insertedId } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/homework/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const hw = await db.collection('homework').findOne({ _id: new ObjectId(req.params.id), schoolId: req.currentUser.schoolId });
        if (!hw) return res.status(404).json({ success: false, message: "Homework not found." });
        if (req.currentUser.role === 'teacher' && hw.teacherId !== req.currentUser.studentId) {
            return res.status(403).json({ success: false, message: "You can only delete homework you posted." });
        }
        await db.collection('homework').deleteOne({ _id: hw._id });
        await db.collection('homeworkStatus').deleteMany({ homeworkId: String(hw._id) });
        await logAudit(req, 'homework_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Merge homework with a given student's completion flags.
async function enrichHomeworkForStudent(items, studentId) {
    const ids = items.map(h => String(h._id));
    const statuses = await db.collection('homeworkStatus').find({ homeworkId: { $in: ids }, studentId }).toArray();
    const doneMap = Object.fromEntries(statuses.map(s => [s.homeworkId, s.done]));
    const today = new Date().toISOString().slice(0, 10);
    return items.map(h => {
        const done = !!doneMap[String(h._id)];
        let dueSoon = false;
        if (h.dueDate && !done) {
            const diffDays = (new Date(h.dueDate) - new Date(today)) / (1000 * 60 * 60 * 24);
            dueSoon = diffDays <= 2; // due within 2 days, or already overdue
        }
        return { ...h, done, dueSoon, overdue: !!(h.dueDate && h.dueDate < today && !done) };
    });
}

app.get('/api/homework/class/:classId', requireAuth, async (req, res) => {
    try {
        const items = await db.collection('homework')
            .find({ classId: req.params.classId, schoolId: req.currentUser.schoolId })
            .sort({ createdAt: -1 }).toArray();
        res.json(items);
    } catch (e) {
        res.status(500).json([]);
    }
});

// Role-aware "my homework": teacher gets what they posted, student gets
// their class's list with completion state merged in, parent needs
// ?studentId= (mirrors the "My Children" / Timetable pattern).
app.get('/api/homework/mine', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        if (user.role === 'teacher') {
            const items = await db.collection('homework')
                .find({ teacherId: user.studentId, schoolId: user.schoolId })
                .sort({ createdAt: -1 }).toArray();
            return res.json(items);
        }
        if (user.role === 'student') {
            const items = await db.collection('homework')
                .find({ classId: user.classId, schoolId: user.schoolId })
                .sort({ createdAt: -1 }).toArray();
            return res.json(await enrichHomeworkForStudent(items, user.studentId));
        }
        if (user.role === 'parent') {
            const studentId = req.query.studentId;
            if (!studentId || !Array.isArray(user.linkedStudentIds) || !user.linkedStudentIds.includes(studentId)) {
                return res.status(403).json({ success: false, message: "Not linked to this student." });
            }
            const student = await db.collection('users').findOne({ studentId, role: 'student', schoolId: user.schoolId });
            if (!student) return res.json([]);
            const items = await db.collection('homework')
                .find({ classId: student.classId, schoolId: user.schoolId })
                .sort({ createdAt: -1 }).toArray();
            return res.json(await enrichHomeworkForStudent(items, studentId));
        }
        if (user.role === 'admin') {
            const items = await db.collection('homework').find({ schoolId: user.schoolId }).sort({ createdAt: -1 }).toArray();
            return res.json(items);
        }
        res.json([]);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// Student marks their own homework done/not-done. Parents view only.
app.post('/api/homework/:id/status', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const { done } = req.body;
        const hw = await db.collection('homework').findOne({ _id: new ObjectId(req.params.id), schoolId: req.currentUser.schoolId });
        if (!hw || hw.classId !== req.currentUser.classId) return res.status(404).json({ success: false, message: "Homework not found." });
        await db.collection('homeworkStatus').updateOne(
            { homeworkId: String(hw._id), studentId: req.currentUser.studentId },
            { $set: { homeworkId: String(hw._id), studentId: req.currentUser.studentId, schoolId: req.currentUser.schoolId, done: !!done, doneAt: done ? new Date() : null } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// =======================================================================
// REPORT CARDS / EXAM RESULTS (Phase 3)
//
// examConfigs: one document per (schoolId, classId, examName) — the
// subject list + max marks a teacher defines once for the whole class,
// plus a workflow status: draft -> submitted -> verified.
// examMarks: one document per student per exam, holding that student's
// marks-per-subject plus server-computed overallMarks/percentage/rank
// and a per-student `released` flag (a teacher can hold back an
// individual card even after "release all").
// =======================================================================
function computeExamTotals(marks, subjects) {
    let overallMarks = 0, overallTotal = 0;
    subjects.forEach(sub => {
        overallTotal += Number(sub.maxMarks) || 0;
        const m = marks && marks[sub.name] !== undefined && marks[sub.name] !== null && marks[sub.name] !== ''
            ? Number(marks[sub.name]) : 0;
        overallMarks += isNaN(m) ? 0 : m;
    });
    const percentage = overallTotal > 0 ? Math.round((overallMarks / overallTotal) * 10000) / 100 : 0;
    return { overallMarks, overallTotal, percentage };
}

// Dense top-3 ranking by percentage descending — ties share a rank.
function assignRanks(rows) {
    const sorted = [...rows].sort((a, b) => b.percentage - a.percentage);
    let rank = 0, lastPct = null, seen = 0;
    const rankByStudent = {};
    for (const r of sorted) {
        seen++;
        if (r.percentage !== lastPct) { rank = seen; lastPct = r.percentage; }
        if (rank <= 3) rankByStudent[r.studentId] = rank;
    }
    return rankByStudent;
}

async function ensureExamMarksForClass(schoolId, classId, examName) {
    const students = await db.collection('users').find({ role: 'student', schoolId, classId }, { projection: { studentId: 1 } }).toArray();
    const existing = await db.collection('examMarks').find({ schoolId, classId, examName }).project({ studentId: 1 }).toArray();
    const existingIds = new Set(existing.map(e => e.studentId));
    const missing = students.filter(s => !existingIds.has(s.studentId));
    if (missing.length > 0) {
        await db.collection('examMarks').insertMany(missing.map(s => ({
            schoolId, classId, examName, studentId: s.studentId,
            marks: {}, overallMarks: 0, overallTotal: 0, percentage: 0, rank: null,
            released: false, updatedAt: new Date()
        })));
    }
}

// Create (or, while still draft, update the subject list of) an exam.
app.post('/api/exams/config', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName, subjects } = req.body;
        if (!classId || !examName || !examName.trim() || !Array.isArray(subjects) || subjects.length === 0) {
            return res.status(400).json({ success: false, message: "Class, exam name, and at least one subject are required." });
        }
        const cleanSubjects = subjects
            .filter(s => s && s.name && String(s.name).trim())
            .map(s => ({ name: String(s.name).trim(), maxMarks: Number(s.maxMarks) || 100 }));
        if (cleanSubjects.length === 0) {
            return res.status(400).json({ success: false, message: "At least one valid subject is required." });
        }
        const name = examName.trim();
        const existing = await db.collection('examConfigs').findOne({ schoolId, classId, examName: name });
        if (existing && existing.status !== 'draft') {
            return res.status(400).json({ success: false, message: `This exam is already ${existing.status} and its subject list is locked.` });
        }
        await db.collection('examConfigs').updateOne(
            { schoolId, classId, examName: name },
            {
                $set: { subjects: cleanSubjects, status: 'draft', updatedAt: new Date() },
                $setOnInsert: { schoolId, classId, examName: name, createdBy: req.currentUser.studentId, createdByName: req.currentUser.name, createdAt: new Date() }
            },
            { upsert: true }
        );
        await ensureExamMarksForClass(schoolId, classId, name);
        await logAudit(req, 'exam_config_save', { classId, examName: name });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/exams/configs/:classId', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const configs = await db.collection('examConfigs')
            .find({ schoolId: req.currentUser.schoolId, classId: req.params.classId })
            .sort({ createdAt: -1 }).toArray();
        res.json(configs);
    } catch (e) {
        res.status(500).json([]);
    }
});

// Full grid: exam config + every student's marks/overall/percentage/rank.
app.get('/api/exams/:classId/:examName', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        await ensureExamMarksForClass(schoolId, classId, examName);
        const marksRows = await db.collection('examMarks').find({ schoolId, classId, examName }).toArray();
        const students = await db.collection('users').find(
            { role: 'student', schoolId, classId }, { projection: { studentId: 1, name: 1 } }
        ).sort({ name: 1 }).toArray();
        const marksByStudent = Object.fromEntries(marksRows.map(m => [m.studentId, m]));
        const rows = students.map(s => {
            const m = marksByStudent[s.studentId] || { marks: {}, overallMarks: 0, overallTotal: 0, percentage: 0, rank: null, released: false };
            return {
                studentId: s.studentId, name: s.name,
                marks: m.marks || {}, overallMarks: m.overallMarks || 0, overallTotal: m.overallTotal || 0,
                percentage: m.percentage || 0, rank: m.rank || null, released: !!m.released
            };
        });
        res.json({ config, rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Bulk-save marks for a class. Server computes overall/percentage for
// every row and re-ranks the whole class in one pass. Locked once the
// exam has moved past 'draft'.
app.post('/api/exams/:classId/:examName/marks', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const { entries } = req.body; // [{ studentId, marks: { subject: number } }]
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'draft') {
            return res.status(400).json({ success: false, message: `Marks are locked — this exam is ${config.status}.` });
        }
        if (!Array.isArray(entries)) return res.status(400).json({ success: false, message: "entries[] required." });

        // Compute totals for the entries being saved, then re-read the
        // whole class so ranking reflects everyone, not just this save.
        for (const entry of entries) {
            const totals = computeExamTotals(entry.marks || {}, config.subjects);
            await db.collection('examMarks').updateOne(
                { schoolId, classId, examName, studentId: entry.studentId },
                { $set: { marks: entry.marks || {}, remarks: entry.remarks || '', ...totals, updatedAt: new Date() } },
                { upsert: true }
            );
        }
        const allRows = await db.collection('examMarks').find({ schoolId, classId, examName }).toArray();
        const rankByStudent = assignRanks(allRows);
        for (const r of allRows) {
            const newRank = rankByStudent[r.studentId] || null;
            if (r.rank !== newRank) {
                await db.collection('examMarks').updateOne({ _id: r._id }, { $set: { rank: newRank } });
            }
        }
        await logAudit(req, 'exam_marks_save', { classId, examName, count: entries.length });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/exams/:classId/:examName/submit', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'draft') return res.status(400).json({ success: false, message: "Only a draft exam can be submitted." });
        await db.collection('examConfigs').updateOne(
            { _id: config._id },
            { $set: { status: 'submitted', submittedAt: new Date(), submittedBy: req.currentUser.studentId, submittedByName: req.currentUser.name } }
        );
        await logAudit(req, 'exam_submit', { classId, examName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Admin: exams awaiting verification across the school.
app.get('/api/admin/exams/pending', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const items = await db.collection('examConfigs')
            .find({ schoolId: req.currentUser.schoolId, status: 'submitted' })
            .sort({ submittedAt: -1 }).toArray();
        res.json(items);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/admin/exams/:classId/:examName/verify', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'submitted') return res.status(400).json({ success: false, message: "Only a submitted exam can be verified." });
        await db.collection('examConfigs').updateOne(
            { _id: config._id },
            { $set: { status: 'verified', verifiedAt: new Date(), verifiedBy: req.currentUser.studentId, verifiedByName: req.currentUser.name } }
        );
        await logAudit(req, 'exam_verify', { classId, examName });
        notifyUser(schoolId, config.createdBy, 'exam', `"${examName}" for ${classId} was verified by admin. You can now release report cards.`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/admin/exams/:classId/:examName/reject', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const { note } = req.body;
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'submitted') return res.status(400).json({ success: false, message: "Only a submitted exam can be rejected." });
        await db.collection('examConfigs').updateOne(
            { _id: config._id },
            { $set: { status: 'draft', rejectNote: note || '', rejectedAt: new Date() } }
        );
        await logAudit(req, 'exam_reject', { classId, examName });
        notifyUser(schoolId, config.createdBy, 'exam', `"${examName}" for ${classId} was sent back for corrections by admin.${note ? ' Note: ' + note : ''}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Release every card in the class/exam to parents+students, except any
// studentIds a teacher explicitly wants to hold back.
app.post('/api/exams/:classId/:examName/release-all', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName } = req.params;
        const excludeStudentIds = Array.isArray(req.body.excludeStudentIds) ? req.body.excludeStudentIds : [];
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'verified') return res.status(400).json({ success: false, message: "Only a verified exam can be released." });

        const result = await db.collection('examMarks').updateMany(
            { schoolId, classId, examName, studentId: { $nin: excludeStudentIds } },
            { $set: { released: true, releasedAt: new Date() } }
        );
        const released = await db.collection('examMarks').find(
            { schoolId, classId, examName, studentId: { $nin: excludeStudentIds } }, { projection: { studentId: 1 } }
        ).toArray();
        for (const r of released) {
            notifyUser(schoolId, r.studentId, 'exam', `Your "${examName}" report card is now available.`);
            if (await isAutomationRuleEnabled(schoolId, 'reportcard_release_notify')) {
                notifyParentsOfStudent(schoolId, r.studentId, 'exam', `The "${examName}" report card for your child is now available.`);
            }
        }
        await logAudit(req, 'exam_release_all', { classId, examName, released: result.modifiedCount, held: excludeStudentIds.length });
        res.json({ success: true, releasedCount: released.length });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Per-student release toggle — a teacher's individual control even after
// (or instead of) a class-wide release.
app.post('/api/exams/:classId/:examName/release/:studentId', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const { classId, examName, studentId } = req.params;
        const { released } = req.body;
        const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
        if (!config) return res.status(404).json({ success: false, message: "Exam not found." });
        if (config.status !== 'verified') return res.status(400).json({ success: false, message: "Only a verified exam's cards can be released." });
        const result = await db.collection('examMarks').updateOne(
            { schoolId, classId, examName, studentId },
            { $set: { released: !!released, releasedAt: released ? new Date() : null } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "Student not found in this exam." });
        if (released) {
            notifyUser(schoolId, studentId, 'exam', `Your "${examName}" report card is now available.`);
            if (await isAutomationRuleEnabled(schoolId, 'reportcard_release_notify')) {
                notifyParentsOfStudent(schoolId, studentId, 'exam', `The "${examName}" report card for your child is now available.`);
            }
        }
        await logAudit(req, 'exam_release_toggle', { classId, examName, studentId, released: !!released });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// Student's own released report cards; parent needs ?studentId=.
app.get('/api/exams/mine', requireAuth, async (req, res) => {
    try {
        const user = req.currentUser;
        let studentId;
        if (user.role === 'student') {
            studentId = user.studentId;
        } else if (user.role === 'parent') {
            studentId = req.query.studentId;
            if (!studentId || !Array.isArray(user.linkedStudentIds) || !user.linkedStudentIds.includes(studentId)) {
                return res.status(403).json({ success: false, message: "Not linked to this student." });
            }
        } else {
            return res.json([]);
        }
        const rows = await db.collection('examMarks')
            .find({ schoolId: user.schoolId, studentId, released: true })
            .sort({ updatedAt: -1 }).toArray();
        res.json(rows.map(r => ({
            classId: r.classId, examName: r.examName, overallMarks: r.overallMarks,
            overallTotal: r.overallTotal, percentage: r.percentage, rank: r.rank, releasedAt: r.releasedAt
        })));
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// Shared authorization + data-assembly for both the JSON detail view and
// the PDF export below.
async function loadReportCardData(req, res) {
    const schoolId = req.currentUser.schoolId;
    const { classId, examName, studentId } = req.params;
    const config = await db.collection('examConfigs').findOne({ schoolId, classId, examName });
    if (!config) { res.status(404).json({ success: false, message: "Exam not found." }); return null; }
    const markRow = await db.collection('examMarks').findOne({ schoolId, classId, examName, studentId });
    if (!markRow) { res.status(404).json({ success: false, message: "Report card not found." }); return null; }

    const isStaff = ['admin', 'teacher'].includes(req.currentUser.role);
    if (!isStaff) {
        const isSelf = req.currentUser.role === 'student' && req.currentUser.studentId === studentId;
        const isParent = req.currentUser.role === 'parent' && Array.isArray(req.currentUser.linkedStudentIds) && req.currentUser.linkedStudentIds.includes(studentId);
        if (!isSelf && !isParent) { res.status(403).json({ success: false, message: "Not authorized for this record." }); return null; }
        if (!markRow.released) { res.status(403).json({ success: false, message: "This report card hasn't been released yet." }); return null; }
    }

    const student = await db.collection('users').findOne({ studentId, schoolId }, { projection: PUBLIC_PROJECTION });
    const school = await db.collection('schools').findOne({ schoolId });
    return {
        school: school ? school.name : 'Ashwamedh Dream International School',
        classId, examName,
        student: {
            studentId, name: student ? student.name : studentId,
            fatherName: (student && student.fatherName) || '',
            motherName: (student && student.motherName) || '',
            dob: (student && student.dob) || ''
        },
        subjects: config.subjects,
        marks: markRow.marks || {},
        overallMarks: markRow.overallMarks || 0,
        overallTotal: markRow.overallTotal || 0,
        percentage: markRow.percentage || 0,
        rank: markRow.rank || null,
        remarks: markRow.remarks || '',
        verified: config.status === 'verified',
        verifiedByName: config.verifiedByName || null,
        released: !!markRow.released
    };
}

app.get('/api/report-card/:classId/:examName/:studentId', requireAuth, async (req, res) => {
    try {
        const data = await loadReportCardData(req, res);
        if (!data) return; // response already sent
        res.json(data);
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/report-card/:classId/:examName/:studentId/pdf', requireAuth, async (req, res) => {
    try {
        const data = await loadReportCardData(req, res);
        if (!data) return; // response already sent

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${data.student.studentId}-${data.examName.replace(/\s+/g, '_')}-report-card.pdf"`);

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        doc.pipe(res);

        const logoPath = path.join(__dirname, 'public', 'logo.png');
        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;

        // Permanent watermark: school logo, centered, low opacity, behind
        // everything else — this is what makes the exported PDF resistant
        // to being screenshot-cropped and passed off without the logo.
        try {
            const wSize = 320;
            doc.opacity(0.08).image(logoPath, (pageWidth - wSize) / 2, (pageHeight - wSize) / 2, { width: wSize });
        } catch (e) { /* logo missing — continue without watermark */ }
        doc.opacity(1);

        // Header
        try { doc.image(logoPath, 40, 36, { width: 56 }); } catch (e) {}
        doc.fillColor('#101A33').font('Helvetica-Bold').fontSize(18).text(data.school, 105, 40, { width: pageWidth - 150 });
        doc.font('Helvetica').fontSize(12).fillColor('#333').text(`Class: ${data.classId}`, 105, 64);
        doc.moveTo(40, 100).lineTo(pageWidth - 40, 100).strokeColor('#101A33').lineWidth(1.5).stroke();

        // Student details
        let y = 114;
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#101A33');
        const detailLine = (label, value) => {
            doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#101A33').text(`${label}: `, 40, y, { continued: true });
            doc.font('Helvetica').fillColor('#222').text(value || 'N/A');
            y += 17;
        };
        detailLine('Student ID', data.student.studentId);
        detailLine('Student Name', data.student.name);
        detailLine('Class', data.classId);
        detailLine('Mother\'s Name', data.student.motherName);
        detailLine('Father\'s Name', data.student.fatherName);
        detailLine('Date of Birth', data.student.dob);

        y += 6;
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#101A33').text(`Exam: ${data.examName}`, 40, y);
        y += 24;

        // Subject-wise marks table
        const tableX = 40, tableW = pageWidth - 80;
        const col1 = tableX, col2 = tableX + tableW * 0.55, col3 = tableX + tableW * 0.77;
        doc.rect(tableX, y, tableW, 22).fill('#101A33');
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10.5);
        doc.text('Subject', col1 + 8, y + 6);
        doc.text('Marks Obtained', col2, y + 6, { width: tableW * 0.22, align: 'center' });
        doc.text('Max Marks', col3, y + 6, { width: tableW * 0.23, align: 'center' });
        y += 22;

        doc.font('Helvetica').fontSize(10.5);
        data.subjects.forEach((sub, i) => {
            const rowH = 20;
            if (i % 2 === 1) doc.rect(tableX, y, tableW, rowH).fill('#F4F1EA');
            doc.fillColor('#222');
            doc.text(sub.name, col1 + 8, y + 5, { width: tableW * 0.5 });
            const obtained = data.marks[sub.name] !== undefined && data.marks[sub.name] !== null ? data.marks[sub.name] : '-';
            doc.text(String(obtained), col2, y + 5, { width: tableW * 0.22, align: 'center' });
            doc.text(String(sub.maxMarks), col3, y + 5, { width: tableW * 0.23, align: 'center' });
            y += rowH;
        });
        doc.rect(tableX, y, tableW, 1).fill('#101A33');
        y += 12;

        // Overall summary
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#101A33');
        doc.text(`Overall Marks: ${data.overallMarks} / ${data.overallTotal}`, tableX, y);
        y += 18;
        doc.text(`Percentage: ${data.percentage}%`, tableX, y);
        y += 18;
        if (data.rank) {
            doc.fillColor('#B8860B').text(`Class Rank: #${data.rank}`, tableX, y);
            y += 18;
        }

        // Teacher remarks (Phase 6B comment bank feeds this field)
        if (data.remarks && data.remarks.trim()) {
            y += 6;
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#101A33').text('Teacher Remarks:', tableX, y);
            y += 15;
            doc.font('Helvetica').fontSize(10).fillColor('#333')
                .text(data.remarks.trim(), tableX, y, { width: tableW });
            y += doc.heightOfString(data.remarks.trim(), { width: tableW }) + 8;
        }

        // Verification stamp
        y += 10;
        if (data.verified) {
            doc.fillColor('#1E7A34').font('Helvetica-Bold').fontSize(12)
                .text(`\u2714  Verified by Admin${data.verifiedByName ? ' — ' + data.verifiedByName : ''}`, tableX, y);
        } else {
            doc.fillColor('#999').font('Helvetica-Oblique').fontSize(10).text('Pending admin verification', tableX, y);
        }

        doc.fontSize(8).fillColor('#999').text(
            `Generated by ADIS Portal on ${new Date().toLocaleDateString()}`,
            40, pageHeight - 50, { width: pageWidth - 80, align: 'center' }
        );

        doc.end();
        await logAudit(req, 'report_card_pdf_export', { classId: data.classId, examName: data.examName, studentId: data.student.studentId });
    } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Could not generate PDF." });
    }
});

// =======================================================================
// ATTENDANCE ANALYTICS + DIGEST (Phase 3)
// Aggregation over the existing attendance collection, plus an
// admin-triggered weekly digest to parents (reuses the notification
// system). Same "no real cron on Render free tier" caveat as fee
// reminders — this is a button, not a scheduled job.
// =======================================================================
app.get('/api/admin/attendance/low', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const days = parseInt(req.query.days) || 30;
        const threshold = parseFloat(req.query.threshold) || 75;
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString().slice(0, 10);

        let studentQuery = { role: 'student', schoolId };
        if (req.currentUser.role === 'teacher') studentQuery.classId = req.currentUser.classId;
        const students = await db.collection('users').find(studentQuery, { projection: { studentId: 1, name: 1, classId: 1 } }).toArray();
        const studentIds = students.map(s => s.studentId);

        const records = await db.collection('attendance').find(
            { schoolId, studentId: { $in: studentIds }, date: { $gte: sinceStr } }
        ).toArray();

        const byStudent = {};
        records.forEach(r => {
            if (!byStudent[r.studentId]) byStudent[r.studentId] = { present: 0, total: 0 };
            byStudent[r.studentId].total++;
            if (r.status === 'Present') byStudent[r.studentId].present++;
        });

        const flagged = students.map(s => {
            const rec = byStudent[s.studentId] || { present: 0, total: 0 };
            const pct = rec.total > 0 ? Math.round((rec.present / rec.total) * 10000) / 100 : null;
            return { studentId: s.studentId, name: s.name, classId: s.classId, presentCount: rec.present, totalCount: rec.total, attendancePct: pct };
        }).filter(s => s.attendancePct !== null && s.attendancePct < threshold)
          .sort((a, b) => a.attendancePct - b.attendancePct);

        res.json({ days, threshold, flagged });
    } catch (e) {
        console.error(e);
        res.status(500).json({ flagged: [] });
    }
});

const ATTENDANCE_DIGEST_COOLDOWN_HOURS = 24 * 6; // roughly weekly

async function sendAttendanceDigest(schoolId, student) {
    const now = new Date();
    if (student.lastAttendanceDigestAt) {
        const hoursSince = (now - new Date(student.lastAttendanceDigestAt)) / (1000 * 60 * 60);
        if (hoursSince < ATTENDANCE_DIGEST_COOLDOWN_HOURS) return false;
    }
    const since = new Date();
    since.setDate(since.getDate() - 7);
    const sinceStr = since.toISOString().slice(0, 10);
    const records = await db.collection('attendance').find({ schoolId, studentId: student.studentId, date: { $gte: sinceStr } }).toArray();
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    if (total === 0) return false; // nothing to report this week
    const pct = Math.round((present / total) * 100);
    notifyParentsOfStudent(schoolId, student.studentId, 'attendance',
        `Weekly attendance for ${student.name}: ${present}/${total} days present (${pct}%).`);
    await db.collection('users').updateOne({ studentId: student.studentId, schoolId }, { $set: { lastAttendanceDigestAt: now } });
    return true;
}

app.post('/api/admin/attendance/digest/send-all', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const students = await db.collection('users').find(
            { role: 'student', schoolId }, { projection: { studentId: 1, name: 1, lastAttendanceDigestAt: 1 } }
        ).toArray();
        let sentCount = 0, skippedCount = 0;
        for (const s of students) {
            const sent = await sendAttendanceDigest(schoolId, s);
            if (sent) sentCount++; else skippedCount++;
        }
        await logAudit(req, 'attendance_digest_bulk_sent', { sentCount, skippedCount });
        res.json({ success: true, sentCount, skippedCount });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.post('/api/admin/attendance/digest/send/:studentId', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const student = await db.collection('users').findOne(
            { studentId: req.params.studentId, role: 'student', schoolId },
            { projection: { studentId: 1, name: 1, lastAttendanceDigestAt: 1 } }
        );
        if (!student) return res.status(404).json({ success: false, message: "Student not found." });
        const sent = await sendAttendanceDigest(schoolId, student);
        await logAudit(req, 'attendance_digest_sent', { targetId: student.studentId, sent });
        res.json({ success: true, sent, message: sent ? "Digest sent." : "A digest was already sent recently, or there's no attendance data this week." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// =======================================================================
// STRUCTURED ERROR LOGGING (Phase 7B)
// A single logError() call replaces scattered console.error(...) calls so
// failures are consistently shaped and, when DB is up, also written to a
// capped `errorLogs` collection — a lightweight substitute for a real log
// drain, browsable the same way the audit log already is.
// =======================================================================
async function logError(where, err, extra) {
    const entry = {
        where,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
        extra: extra || null,
        date: new Date()
    };
    console.error(`[${where}]`, entry.message);
    try {
        if (db) await db.collection('errorLogs').insertOne(entry);
    } catch (e) {
        // If even the error logger fails (e.g. DB briefly down), don't throw —
        // console.error above already captured it.
    }
}

// Admin/owner can browse recent server errors the same way they browse the
// audit log — a cheap alternative to a real log-drain service.
app.get('/api/admin/error-log', requireAuth, requireRole('admin', 'owner'), async (req, res) => {
    try {
        const logs = await db.collection('errorLogs').find({}).sort({ date: -1 }).limit(200).toArray();
        res.json(logs);
    } catch (e) {
        res.status(500).json([]);
    }
});

// =======================================================================
// MONITORING (Phase 7B)
// Unauthenticated, minimal, cheap to ping — meant for an external uptime
// checker (e.g. the same cron-job.org account already used for reminders)
// to catch a sleeping/crashed instance before a user does.
// =======================================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        dbConnected: !!db,
        uptimeSeconds: Math.round(process.uptime()),
        time: new Date().toISOString()
    });
});

// =======================================================================
// REAL CRON (Phase 5)
// Render's free tier sleeps on idle, so an in-process scheduler (setInterval,
// node-cron, etc.) can't be trusted to fire. These endpoints exist so an
// external pinger — e.g. a free cron-job.org job — can hit them on a
// schedule and get a REAL automatic sweep across every school, instead of
// admins clicking "Remind All" / "Send to All" by hand. Protected by a
// shared-secret key rather than requireAuth since there's no logged-in
// admin session behind a scheduled HTTP call.
//
// Setup:
//   1. Set CRON_SECRET in your environment (any long random string).
//   2. Point cron-job.org (or similar) at, once a day:
//        POST https://<your-app>/api/cron/fee-reminders?key=<CRON_SECRET>
//        POST https://<your-app>/api/cron/attendance-digest?key=<CRON_SECRET>
//      (the per-student 24h/6-day cooldowns already baked into
//      sendFeeReminder/sendAttendanceDigest mean it's safe to ping daily —
//      most students will just be skipped until they're actually due.)
// =======================================================================
const CRON_SECRET = process.env.CRON_SECRET || null;
function requireCronSecret(req, res, next) {
    if (!CRON_SECRET) {
        return res.status(503).json({ success: false, message: "Cron endpoints are disabled — set CRON_SECRET in the environment to enable them." });
    }
    const key = req.query.key || req.header('x-cron-secret');
    if (key !== CRON_SECRET) {
        return res.status(401).json({ success: false, message: "Invalid or missing cron key." });
    }
    next();
}

app.post('/api/cron/fee-reminders', requireCronSecret, async (req, res) => {
    try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + 3);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const students = await db.collection('users').find(
            { role: 'student', feeDueDate: { $exists: true, $ne: null, $lte: cutoffStr } },
            { projection: { studentId: 1, name: 1, schoolId: 1, totalFees: 1, feesPaid: 1, feeDueDate: 1, lastFeeReminderAt: 1 } }
        ).toArray();
        const overdue = students.filter(s => (s.totalFees || 0) - (s.feesPaid || 0) > 0);

        let sentCount = 0, skippedCount = 0;
        for (const s of overdue) {
            if (!(await isAutomationRuleEnabled(s.schoolId, 'fees_reminder_schedule'))) { skippedCount++; continue; }
            const sent = await sendFeeReminder(s.schoolId, s);
            if (sent) sentCount++; else skippedCount++;
        }
        console.log(`[cron] fee-reminders: ${sentCount} sent, ${skippedCount} skipped (across all schools)`);
        res.json({ success: true, sentCount, skippedCount });
    } catch (e) {
        console.error('[cron] fee-reminders failed:', e);
        res.status(500).json({ success: false, message: "Cron sweep failed." });
    }
});

app.post('/api/cron/attendance-digest', requireCronSecret, async (req, res) => {
    try {
        const students = await db.collection('users').find(
            { role: 'student' }, { projection: { studentId: 1, name: 1, schoolId: 1, lastAttendanceDigestAt: 1 } }
        ).toArray();

        let sentCount = 0, skippedCount = 0;
        for (const s of students) {
            const sent = await sendAttendanceDigest(s.schoolId, s);
            if (sent) sentCount++; else skippedCount++;
        }
        console.log(`[cron] attendance-digest: ${sentCount} sent, ${skippedCount} skipped (across all schools)`);
        res.json({ success: true, sentCount, skippedCount });
    } catch (e) {
        console.error('[cron] attendance-digest failed:', e);
        res.status(500).json({ success: false, message: "Cron sweep failed." });
    }
});

// =======================================================================
// AUTOMATION RULES ENGINE (Phase 7A)
// Extends the existing /api/cron/* + CRON_SECRET pinger pattern from
// Phase 5 rather than introducing a second scheduling mechanism. Each
// rule is a simple on/off toggle per school (defaults to ON so behavior
// matches what already happens today); a single sweep endpoint checks
// all of them and respects each rule's own per-student/per-class cooldown,
// the same pattern sendFeeReminder/sendAttendanceDigest already use.
// =======================================================================
const AUTOMATION_RULE_DEFS = [
    { key: 'attendance_teacher_reminder', label: "Remind teachers if attendance isn't submitted by 10:30" },
    { key: 'attendance_parent_low', label: "Notify parents when attendance drops below 75%" },
    { key: 'homework_student_reminder', label: "Remind students 1 day before homework is due" },
    { key: 'homework_parent_overdue', label: "Notify parents when homework goes repeatedly overdue (3+ days)" },
    { key: 'fees_reminder_schedule', label: "Automatic fee reminders (7/3/0/overdue days) — controls the existing daily cron sweep" },
    { key: 'reportcard_release_notify', label: "Notify parents when a report card is released" }
];

app.get('/api/admin/automation-rules', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const schoolId = req.currentUser.schoolId;
        const saved = await db.collection('automationRules').find({ schoolId }).toArray();
        const savedByKey = Object.fromEntries(saved.map(r => [r.ruleKey, r.enabled]));
        res.json(AUTOMATION_RULE_DEFS.map(d => ({ ...d, enabled: savedByKey[d.key] !== undefined ? savedByKey[d.key] : true })));
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/admin/automation-rules/toggle', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { ruleKey, enabled } = req.body;
        if (!AUTOMATION_RULE_DEFS.some(d => d.key === ruleKey)) return res.status(400).json({ success: false, message: "Unknown rule." });
        await db.collection('automationRules').updateOne(
            { schoolId: req.currentUser.schoolId, ruleKey },
            { $set: { enabled: !!enabled, updatedAt: new Date() } },
            { upsert: true }
        );
        await logAudit(req, 'automation_rule_toggle', { ruleKey, enabled: !!enabled });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

async function isAutomationRuleEnabled(schoolId, ruleKey) {
    const row = await db.collection('automationRules').findOne({ schoolId, ruleKey });
    return row ? !!row.enabled : true; // default ON
}

app.post('/api/cron/automation-sweep', requireCronSecret, async (req, res) => {
    const summary = { attendanceTeacherReminders: 0, attendanceParentAlerts: 0, homeworkStudentReminders: 0, homeworkParentOverdue: 0 };
    try {
        const schools = await db.collection('schools').find({}).toArray();
        const nowHM = new Date().toTimeString().slice(0, 5);
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayDay = todayDayCode();

        for (const school of schools) {
            const schoolId = school.schoolId;

            // (a) Remind teachers if attendance isn't submitted by 10:30
            if (nowHM >= '10:30' && await isAutomationRuleEnabled(schoolId, 'attendance_teacher_reminder')) {
                const slots = await db.collection('timetableSlots').find({ schoolId, day: todayDay }).toArray();
                const classTeacherPairs = [...new Map(slots.map(s => [`${s.classId}|${s.teacherId}`, s])).values()];
                for (const pair of classTeacherPairs) {
                    const marked = await db.collection('attendance').countDocuments({ schoolId, classId: pair.classId, date: todayStr });
                    if (marked > 0) continue;
                    const teacher = await db.collection('users').findOne({ studentId: pair.teacherId, role: 'teacher' });
                    if (!teacher) continue;
                    const cooldownKey = `lastAttReminderAt_${pair.classId}_${todayStr}`;
                    if (teacher[cooldownKey]) continue;
                    await notifyUser(schoolId, pair.teacherId, 'attendance', `Reminder: attendance for ${pair.classId} hasn't been submitted today.`);
                    await db.collection('users').updateOne({ studentId: pair.teacherId }, { $set: { [cooldownKey]: new Date() } });
                    summary.attendanceTeacherReminders++;
                }
            }

            // (b) Notify parents when attendance drops below 75% (7-day cooldown per student)
            if (await isAutomationRuleEnabled(schoolId, 'attendance_parent_low')) {
                const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
                const cutoffStr = cutoff.toISOString().slice(0, 10);
                const students = await db.collection('users').find({ schoolId, role: 'student' }, { projection: { studentId: 1, lastAttendanceAlertAt: 1 } }).toArray();
                for (const s of students) {
                    if (s.lastAttendanceAlertAt && (new Date() - new Date(s.lastAttendanceAlertAt)) < 7 * 24 * 3600 * 1000) continue;
                    const records = await db.collection('attendance').find({ studentId: s.studentId, schoolId, date: { $gte: cutoffStr } }).toArray();
                    if (records.length < 5) continue; // not enough data yet
                    const pct = Math.round((records.filter(r => r.status === 'Present').length / records.length) * 100);
                    if (pct >= 75) continue;
                    await notifyParentsOfStudent(schoolId, s.studentId, 'attendance', `Attendance alert: your child's attendance is ${pct}%, below the school's 75% recommended level.`);
                    await db.collection('users').updateOne({ studentId: s.studentId }, { $set: { lastAttendanceAlertAt: new Date() } });
                    summary.attendanceParentAlerts++;
                }
            }

            // (c) Remind students 1 day before homework is due (per-homework, per-student, once)
            if (await isAutomationRuleEnabled(schoolId, 'homework_student_reminder')) {
                const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = tomorrow.toISOString().slice(0, 10);
                const dueHomework = await db.collection('homework').find({ schoolId, dueDate: tomorrowStr }).toArray();
                for (const hw of dueHomework) {
                    const students = await db.collection('users').find({ schoolId, role: 'student', classId: hw.classId }).toArray();
                    for (const st of students) {
                        const status = await db.collection('homeworkStatus').findOne({ homeworkId: String(hw._id), studentId: st.studentId });
                        if (status && (status.done || status.reminderSentAt)) continue;
                        await notifyUser(schoolId, st.studentId, 'homework', `Reminder: "${hw.title}" is due tomorrow.`);
                        await db.collection('homeworkStatus').updateOne(
                            { homeworkId: String(hw._id), studentId: st.studentId },
                            { $set: { reminderSentAt: new Date() }, $setOnInsert: { schoolId, done: false } },
                            { upsert: true }
                        );
                        summary.homeworkStudentReminders++;
                    }
                }
            }

            // (d) Notify parents when homework goes repeatedly overdue (3+ days late, once)
            if (await isAutomationRuleEnabled(schoolId, 'homework_parent_overdue')) {
                const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 3);
                const cutoffStr = cutoff.toISOString().slice(0, 10);
                const overdueHomework = await db.collection('homework').find({ schoolId, dueDate: { $ne: null, $lte: cutoffStr } }).toArray();
                for (const hw of overdueHomework) {
                    const students = await db.collection('users').find({ schoolId, role: 'student', classId: hw.classId }).toArray();
                    for (const st of students) {
                        const status = await db.collection('homeworkStatus').findOne({ homeworkId: String(hw._id), studentId: st.studentId });
                        if (status && (status.done || status.overdueNotifiedAt)) continue;
                        await notifyParentsOfStudent(schoolId, st.studentId, 'homework', `"${hw.title}" is now several days overdue and still not marked done.`);
                        await db.collection('homeworkStatus').updateOne(
                            { homeworkId: String(hw._id), studentId: st.studentId },
                            { $set: { overdueNotifiedAt: new Date() }, $setOnInsert: { schoolId, done: false } },
                            { upsert: true }
                        );
                        summary.homeworkParentOverdue++;
                    }
                }
            }
        }
        console.log('[cron] automation-sweep:', JSON.stringify(summary));
        res.json({ success: true, ...summary });
    } catch (e) {
        console.error('[cron] automation-sweep failed:', e);
        res.status(500).json({ success: false, message: "Automation sweep failed.", ...summary });
    }
});

// =======================================================================
// SCHEDULED BACKUPS (Phase 7B)
// A true `mongodump` needs the Mongo tools binary, which isn't present on
// a stock Render Node deployment (no apt access, no custom buildpack) — so
// this is a logical JSON export via the driver instead: every collection,
// dumped to one JSON file, uploaded to Cloudinary if configured (same
// persistence story as file uploads in Phase 5) or written to local disk
// otherwise. If you're on MongoDB Atlas, Atlas's own automated backups are
// the more robust option — this exists for anyone self-hosting Mongo, or
// as a second safety net either way. Same CRON_SECRET pinger pattern.
// =======================================================================
const BACKUP_COLLECTIONS = [
    'users', 'schools', 'classes', 'attendance', 'homework', 'homeworkStatus',
    'homeworkTemplates', 'examConfigs', 'examMarks', 'chatThreads', 'chatMessages',
    'chatQuickReplies', 'feedback', 'notifications', 'auditLogs', 'feePayments',
    'timetableSlots', 'automationRules', 'reportCardComments'
];

app.post('/api/cron/backup', requireCronSecret, async (req, res) => {
    try {
        const dump = { generatedAt: new Date().toISOString(), collections: {} };
        for (const name of BACKUP_COLLECTIONS) {
            dump.collections[name] = await db.collection(name).find({}).toArray();
        }
        const filename = `adis-backup-${new Date().toISOString().slice(0, 10)}.json`;
        const buffer = Buffer.from(JSON.stringify(dump), 'utf8');

        let location;
        if (CLOUDINARY_ENABLED) {
            location = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream({ folder: 'backups', resource_type: 'raw', public_id: filename }, (err, result) => {
                    if (err) return reject(err);
                    resolve(result.secure_url);
                });
                stream.end(buffer);
            });
        } else {
            fs.mkdirSync('./backups/', { recursive: true });
            fs.writeFileSync(`./backups/${filename}`, buffer);
            location = `local:./backups/${filename} (ephemeral — set CLOUDINARY_* env vars so backups survive redeploys)`;
        }

        const sizeKB = Math.round(buffer.length / 1024);
        console.log(`[cron] backup: ${filename} (${sizeKB} KB) -> ${location}`);
        res.json({ success: true, filename, sizeKB, location });
    } catch (e) {
        console.error('[cron] backup failed:', e);
        res.status(500).json({ success: false, message: "Backup failed." });
    }
});

// =======================================================================
// SOCKET.IO (Phase 5)
// Swaps chat's transport from pure polling to push, while leaving the data
// model (chatThreads/chatMessages) and the REST endpoints above completely
// unchanged — the frontend keeps its polling as a fallback, but now gets
// an instant nudge instead of waiting up to 8s. Every socket authenticates
// the same way REST requests do (x-user-id/x-session-id, just sent once at
// handshake instead of per-request) and joins a personal room named
// `user:<studentId>`, so a message handler only needs to know the
// recipient's id to reach every tab/device they have open.
// =======================================================================
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

io.use(async (socket, next) => {
    try {
        const { userId, sessionId } = socket.handshake.auth || {};
        if (!userId || !sessionId) return next(new Error('Not logged in.'));
        const user = await db.collection('users').findOne({ studentId: userId });
        if (!user || user.currentSessionId !== sessionId) return next(new Error('Session expired or logged in elsewhere.'));
        if (user.sessionExpiresAt && new Date(user.sessionExpiresAt) < new Date()) return next(new Error('Session expired.'));
        socket.studentId = user.studentId;
        next();
    } catch (e) {
        next(new Error('Auth check failed.'));
    }
});

io.on('connection', (socket) => {
    socket.join(`user:${socket.studentId}`);
    socket.on('disconnect', () => {});
});

// Pushes a chat message to a specific user's room (all their open
// tabs/devices at once). Safe no-op if they aren't connected — the
// existing REST polling still picks it up on the next cycle.
function emitChatMessage(recipientId, threadId, messageDoc) {
    io.to(`user:${recipientId}`).emit('chat:new-message', { threadId: String(threadId), message: messageDoc });
}

httpServer.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT} (HTTP + Socket.io)`);
});
