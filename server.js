const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3000; // You were missing the PORT variable definition
const multer = require('multer');
const path = require('path');
// Setup storage engine
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function(req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Init upload
const upload = multer({ storage: storage });
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads')); // <--- ADD THIS LINE

// --- MONGODB CLOUD SETUP ---
// Ensure this URI is correct and your IP is whitelisted in MongoDB Atlas
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

// --- BACKEND MINI-SNOWFLAKE BACKUP GENERATOR ---
const SCHOOL_EPOCH = 1780000000; 
const MACHINE_ID = "1"; // Identifies this primary web server process
let lastTimestamp = -1;
let sequence = 0;

function serverGenerateSnowflake() {
    let currentTimestamp = Math.floor(Date.now() / 1000);
    let timeOffset = currentTimestamp - SCHOOL_EPOCH; 
    
    if (currentTimestamp === lastTimestamp) {
        sequence = (sequence + 1) % 10;
    } else {
        sequence = 0;
        lastTimestamp = currentTimestamp;
    }
    return `${timeOffset}${MACHINE_ID}${sequence}`;
}


// Middleware to block access during maintenance
app.use((req, res, next) => {
    // Allow the admin to bypass maintenance to fix things
    if (maintenanceMode && !req.path.includes('/api/admin/maintenance') && !req.path.includes('/api/login')) {
        return res.status(503).json({ 
            success: false, 
            maintenance: true, 
            message: "ADIS Portal is under scheduled maintenance for high-level upgrades. Please check back soon!" 
        });
    }
    next();
});

// Admin Route to toggle Maintenance
app.post('/api/admin/maintenance/toggle', (req, res) => {
    const { status } = req.body; // true or false
    maintenanceMode = status;
    console.log(`⚠️ Maintenance Mode: ${maintenanceMode ? 'ON' : 'OFF'}`);
    res.json({ success: true, maintenance: maintenanceMode });
});


// Check status (for frontend)
app.get('/api/maintenance/status', (req, res) => {
    res.json({ maintenance: maintenanceMode });
});


// --- Serve index.html on root route ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// --- API ROUTES ---

// 1. Login Route with Session Tracking for Single-Device Login
app.post('/api/login', async (req, res) => {
    const { id, password } = req.body;
    try {
        const user = await db.collection('users').findOne({ studentId: id });
        if (user && await bcrypt.compare(password, user.password)) {
            
            // Create a unique Session ID
            const newSessionId = Date.now().toString() + Math.random();
            
            // Save Session to DB (Kicks out other devices)
            await db.collection('users').updateOne(
                { studentId: id },
                { $set: { currentSessionId: newSessionId } }
            );

            res.json({ 
                success: true, 
                sessionId: newSessionId,
                user: { 
                    name: user.name, 
                    role: user.role, 
                    id: user.studentId, 
                    classId: user.classId,
                    performance: user.performance || {} // Send performance data
                } 
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// Verify Session (Single Device Guard)
app.get('/api/verify-session', async (req, res) => {
    const { userId, sessionId } = req.query;
    const user = await db.collection('users').findOne({ studentId: userId });
    if (user && user.currentSessionId === sessionId) {
        res.json({ active: true });
    } else {
        res.json({ active: false });
    }
});

// --- UPDATED ROLE-BASED ROUTES (UPSERT) ---

// A. Add/Update Teacher Route (Admin Only)
app.post('/api/admin/teachers/upsert', async (req, res) => {
    try {
        const { id, password, name, classId } = req.body;
        
        // Hash password only if it's provided
        let updateData = { name, classId, role: "teacher" };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        // --- UPSERT LOGIC ---
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "teacher" },
            { $set: updateData },
            { upsert: true } // Create if doesn't exist, update if it does
        );

        if (result.upsertedCount > 0) {
            res.json({ success: true, message: "Teacher created successfully" });
        } else {
            res.json({ success: true, message: "Teacher updated successfully" });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
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

// C. Add/Update Student Route (Teacher Only)
app.post('/api/teacher/students/upsert', async (req, res) => {
    try {
        let { id, password, name, classId, totalFees } = req.body;
        
        // 1. Validate that a name exists
        if (!name || name.trim() === "") {
            return res.status(400).json({ success: false, message: "Student name is required." });
        }

        // 2. Server-side Safety Net: If frontend didn't pass an ID, generate it here
        if (!id || String(id).trim() === "") {
            id = serverGenerateSnowflake();
        } else {
            id = String(id).trim(); // Force it to a clean string type
        }

        // 3. Data to update for both new and existing students
        let updateData = { 
            name: name,
            classId: classId,
            totalFees: parseFloat(totalFees) || 0,
            role: "student" 
        };

        // 4. Hash password only if it's provided and not empty
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        // --- UPSERT LOGIC WITH EXPLICIT STRING ID ---
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "student" }, // Enforces looking for the string key
            { 
                $set: updateData,
                $setOnInsert: { 
                    feesPaid: 0, 
                    performance: { 
                        academic: 0, 
                        tech: 0, 
                        arts: 0, 
                        sports: 0, 
                        practical: 0, 
                        feedback: "Welcome to ADIS!"
                    }
                }
            },
            { upsert: true }
        );

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


// D. Delete Student Route (Teacher Only)
app.delete('/api/teacher/students/:id', async (req, res) => {
    try {
        await db.collection('users').deleteOne({ studentId: req.params.id, role: "student" });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// --- EXISTING ROUTES (Maintained) ---

// 3. Get students by class
app.get('/api/students/class/:classId', async (req, res) => {
    try {
        const students = await db.collection('users').find({ classId: req.params.classId, role: "student" }).toArray();
        res.json(students);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// Get all teachers
app.get('/api/teachers', async (req, res) => {
    try {
        const teachers = await db.collection('users').find({ role: "teacher" }).toArray();
        res.json(teachers);
    } catch (e) {
        res.status(500).json([]);
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

// 9. Post/Update Announcement (WITH IMAGE SUPPORT)
app.post('/api/announcements', upload.single('image'), async (req, res) => {
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
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});


// Delete Announcement
app.delete('/api/announcements/:id', async (req, res) => {
    try {
        await db.collection('announcements').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
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

// --- PERFORMANCE TRACKER FEATURES ---

// Update Performance (Teacher or Admin)
app.post('/api/performance/update', async (req, res) => {
    try {
        const { studentId, performanceData } = req.body;
        
        // This updates Academics, Tech, Arts, Sports and creates the "Direct Visibility"
        await db.collection('users').updateOne(
            { studentId: studentId },
            { $set: { performance: performanceData } }
        );
        
        res.json({ success: true, message: "Performance updated and live for parents!" });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Admin: Get Active Sessions (Monitor who is online)
app.get('/api/admin/active-sessions', async (req, res) => {
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

// 12. Get materials by class
app.get('/api/materials/:classId', async (req, res) => {
    try {
        const materials = await db.collection('materials').find({ classId: req.params.classId }).sort({ date: -1 }).toArray();
        res.json(materials);
    } catch (e) {
        res.status(500).json({ error: "Database error" });
    }
});

// 13. Create a new class (Admin Only)
app.post('/api/admin/classes/create', async (req, res) => {
    try {
        const { className } = req.body;
        // Check if class already exists
        const existingClass = await db.collection('classes').findOne({ className });
        if (existingClass) {
            return res.status(400).json({ success: false, message: "Class already exists" });
        }
        
        await db.collection('classes').insertOne({ className, createdAt: new Date() });
        res.json({ success: true, message: "Class created successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// 14. Get all classes
app.get('/api/classes', async (req, res) => {
    try {
        const classes = await db.collection('classes').find().toArray();
        res.json(classes);
    } catch (e) {
        res.status(500).json([]);
    }
});

// 15. Delete a class (Admin Only) - MODIFIED FOR SAFETY
app.delete('/api/admin/classes/delete/:className', async (req, res) => {
    try {
        const className = req.params.className;
        
        // 🛡️ CHECK: Are there students still in this class?
        const studentsInClass = await db.collection('users').countDocuments({ 
            classId: className, 
            role: "student" 
        });

        if (studentsInClass > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Cannot delete class. There are still ${studentsInClass} students in ${className}. Please transfer them first.` 
            });
        }
        
        // If no students, delete the class
        await db.collection('classes').deleteOne({ className });
        
        res.json({ success: true, message: "Class deleted successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});


// --- ADD TO API ROUTES IN server.js ---

// 16. Transfer all students from one class to another (Admin Only)
app.post('/api/admin/transfer-class', async (req, res) => {
    try {
        const { fromClass, toClass } = req.body;
        
        // Update all students belonging to fromClass
        const result = await db.collection('users').updateMany(
            { classId: fromClass, role: "student" },
            { $set: { classId: toClass } }
        );
        
        res.json({ 
            success: true, 
            message: `Successfully transferred ${result.modifiedCount} students from ${fromClass} to ${toClass}` 
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

// 17. Get all users arranged classwise (Admin Only)
app.get('/api/admin/users-classwise', async (req, res) => {
    try {
        // Aggregate users and group them by classId
        const data = await db.collection('users').aggregate([
            { $match: { role: { $ne: "admin" } } }, // Exclude admins
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
// ... (all other routes above)

// 18. Get student list based on role (Admin sees all, Teachers see assigned class)
app.post('/api/teacher/students/list', async (req, res) => {
    try {
        const { role, classId } = req.body;
        let query = { role: "student" };

        // Teachers can only see students in their class
        if (role === "teacher") {
            query.classId = classId;
        }

        const students = await db.collection('users').find(query).sort({ classId: 1, name: 1 }).toArray();
        res.json(students);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// Admin Overwrite: Directly edit any student's performance or info
app.post('/api/admin/overwrite-student', async (req, res) => {
    try {
        const { targetId, updateFields } = req.body;
        
        // This allows Admin to fix Marks, Tech scores, or Names instantly
        await db.collection('users').updateOne(
            { studentId: targetId },
            { $set: updateFields }
        );
        
        res.json({ success: true, message: "Admin Overwrite Complete" });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Session Guard (Single Device Login)
app.get('/api/verify-session', async (req, res) => {
    const { userId, sessionId } = req.query;
    const user = await db.collection('users').findOne({ studentId: userId });
    if (user && user.currentSessionId === sessionId) {
        res.json({ active: true });
    } else {
        res.json({ active: false }); // This triggers the logout on frontend
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
