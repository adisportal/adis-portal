const express = require('express');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// --- MONGODB CLOUD SETUP ---
const uri = "mongodb+srv://ADMIN:Testing123@cluster0.52yyau2.mongodb.net/?appName=Cluster0";
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

// --- FIX: Serve index.html on root route ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});
// ----------------------------------------------

// --- API ROUTES ---

// 1. Login Route
app.post('/api/login', async (req, res) => {
    const { id, password } = req.body;
    try {
        const user = await db.collection('users').findOne({ studentId: id });
        if (user && password === user.password) { // 🛑 TEMPORARY BYPASS
            res.json({ success: true, user: { name: user.name, role: user.role, id: user.studentId, classId: user.classId } });
        } else {
            res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// --- NEW ROLE-BASED ROUTES ---

// A. Add Teacher Route (Admin Only)
app.post('/api/admin/teachers', async (req, res) => {
    try {
        const { password, ...userData } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('users').insertOne({
            ...userData,
            role: "teacher", // --- Explicitly set role
            password: hashedPassword
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// B. Delete Teacher Route (Admin Only)
app.delete('/api/admin/teachers/:id', async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "teacher" });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// C. Add Student Route (Teacher Only)
app.post('/api/teacher/students', async (req, res) => {
    try {
        const { password, ...userData } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('users').insertOne({
            ...userData,
            role: "student", // --- Explicitly set role
            password: hashedPassword
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// D. Delete Student Route (Teacher Only)
app.delete('/api/teacher/students/:id', async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "student" });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// --- EXISTING ROUTES ---

// 3. Get students by class
app.get('/api/students/class/:classId', async (req, res) => {
    try {
        const students = await db.collection('users').find({ classId: req.params.classId, role: "student" }).toArray();
        res.json(students);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// 4. Update fees for a student
app.post('/api/fees/update', async (req, res) => {
    try {
        const { studentId, amountPaid } = req.body;
        await db.collection('users').updateOne(
            { studentId: studentId },
            { $inc: { feesPaid: amountPaid } }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 5. Get attendance for a specific class and date (Teacher View)
app.get('/api/attendance/:classId/:date', async (req, res) => {
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

// 6. Update/Save attendance for a specific student and date (Teacher Action)
app.post('/api/attendance/update', async (req, res) => {
    try {
        const { studentId, date, status, classId } = req.body;
        await db.collection('attendance').updateOne(
            { studentId: studentId, date: date },
            { $set: { status: status, classId: classId } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 7. Get student profile for dashboard
app.get('/api/student/profile/:studentId', async (req, res) => {
    try {
        const student = await db.collection('users').findOne({ studentId: req.params.studentId });
        res.json(student);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// 8. Get all attendance for one student (Student View)
app.get('/api/student/attendance/:studentId', async (req, res) => {
    try {
        const records = await db.collection('attendance').find({ 
            studentId: req.params.studentId 
        }).sort({ date: -1 }).toArray();
        res.json(records);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// 9. Post a new announcement (Teacher)
app.post('/api/announcements', async (req, res) => {
    try {
        const newAnnouncement = { ...req.body, date: new Date() };
        await db.collection('announcements').insertOne(newAnnouncement);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 10. Get all announcements
app.get('/api/announcements', async (req, res) => {
    try {
        const announcements = await db.collection('announcements').find().sort({ date: -1 }).limit(10).toArray();
        res.json(announcements);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// 11. Post a new study material (Teacher)
app.post('/api/materials', async (req, res) => {
    try {
        const newMaterial = { ...req.body, date: new Date() };
        await db.collection('materials').insertOne(newMaterial);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 12. Get materials by class
app.get('/api/materials/:classId', async (req, res) => {
    try {
        const materials = await db.collection('materials').find({ classId: req.params.classId }).sort({ date: -1 }).toArray();
        res.json(materials);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
