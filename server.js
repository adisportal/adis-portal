const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3000;
const multer = require('multer');
const path = require('path');

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

// Admin-only: toggle maintenance mode
app.post('/api/admin/maintenance/toggle', requireAuth, requireRole('admin'), async (req, res) => {
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

            res.json({
                success: true,
                sessionId: newSessionId,
                user: {
                    name: user.name,
                    role: user.role,
                    id: user.studentId,
                    classId: user.classId,
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
// ADMIN: TEACHERS
// =======================================================================
app.post('/api/admin/teachers/upsert', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { id, password, name, classId } = req.body;
        if (!id || !name) {
            return res.status(400).json({ success: false, message: "ID and name are required." });
        }
        let updateData = { name, classId, role: "teacher" };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "teacher" },
            { $set: updateData },
            { upsert: true }
        );
        await logAudit(req, 'teacher_upsert', { targetId: id });
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
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "teacher" });
        await logAudit(req, 'teacher_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/teachers', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const teachers = await db.collection('users').find({ role: "teacher" }, { projection: PUBLIC_PROJECTION }).toArray();
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
        if (!id || String(id).trim() === "") {
            id = serverGenerateSnowflake();
        } else {
            id = String(id).trim();
        }

        let updateData = {
            name: name,
            classId: classId,
            totalFees: parseFloat(totalFees) || 0,
            role: "student"
        };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        const result = await db.collection('users').updateOne(
            { studentId: id, role: "student" },
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
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "student" });
        await logAudit(req, 'student_delete', { targetId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/teacher/students/list', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { role, classId } = req.body;
        let query = { role: "student" };
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
            { classId: req.params.classId, role: "student" },
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
            { studentId: studentId },
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
            date: req.params.date
        }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/attendance/update', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
    try {
        const { studentId, date, status, classId } = req.body;
        await db.collection('attendance').updateOne(
            { studentId: studentId, date: date },
            { $set: { status: status, classId: classId } },
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
            studentId: req.params.studentId
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
            { studentId: req.params.studentId },
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
            date: new Date()
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
        const records = await db.collection('announcements').find({}).sort({ date: -1 }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

app.delete('/api/announcements/:id', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        await db.collection('announcements').deleteOne({ _id: new ObjectId(req.params.id) });
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
        const newMaterial = { ...req.body, date: new Date() };
        await db.collection('materials').insertOne(newMaterial);
        await logAudit(req, 'material_post', {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/materials/:classId', requireAuth, async (req, res) => {
    try {
        const materials = await db.collection('materials').find({ classId: req.params.classId }).sort({ date: -1 }).toArray();
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
            { studentId: studentId },
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
        const existingClass = await db.collection('classes').findOne({ className });
        if (existingClass) {
            return res.status(400).json({ success: false, message: "Class already exists" });
        }
        await db.collection('classes').insertOne({ className, createdAt: new Date() });
        await logAudit(req, 'class_create', { className });
        res.json({ success: true, message: "Class created successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.get('/api/classes', requireAuth, async (req, res) => {
    try {
        const classes = await db.collection('classes').find().toArray();
        res.json(classes);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.delete('/api/admin/classes/delete/:className', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const className = req.params.className;
        const studentsInClass = await db.collection('users').countDocuments({ classId: className, role: "student" });
        if (studentsInClass > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete class. There are still ${studentsInClass} students in ${className}. Please transfer them first.`
            });
        }
        await db.collection('classes').deleteOne({ className });
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
            { classId: fromClass, role: "student" },
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
            { $match: { role: { $ne: "admin" } } },
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
        await db.collection('users').updateOne(
            { studentId: targetId },
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
            .find({ currentSessionId: { $ne: null } })
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
        const logs = await db.collection('auditLogs').find({}).sort({ date: -1 }).limit(200).toArray();
        res.json(logs);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
