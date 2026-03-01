const express = require('express');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// --- MONGODB CLOUD SETUP ---
// Ensure this URI is correct and your IP is whitelisted in MongoDB Atlas
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

// --- Serve index.html on root route ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// --- API ROUTES ---

// 1. Login Route
app.post('/api/login', async (req, res) => {
    const { id, password } = req.body;
    try {
        const user = await db.collection('users').findOne({ studentId: id });
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, user: { name: user.name, role: user.role, id: user.studentId, classId: user.classId } });
        } else {
            res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: "Server Error" });
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
        const { id, password, name, classId, totalFees } = req.body;
        
        // 1. Data to update for both new and existing students
        let updateData = { 
            name: name,
            classId: classId,
            totalFees: totalFees,
            role: "student" 
        };

        // 2. Hash password only if it's provided and not empty
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        // --- UPSERT LOGIC ---
        const result = await db.collection('users').updateOne(
            { studentId: id, role: "student" },
            { 
                $set: updateData,
                $setOnInsert: { feesPaid: 0 } // Initialize only if creating
            },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            res.json({ success: true, message: "Student created successfully" });
        } else if (result.modifiedCount > 0 || result.matchedCount > 0) {
            res.json({ success: true, message: "Student updated successfully" });
        } else {
            res.status(400).json({ success: false, message: "No changes made" });
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

// --- REMOVE THE DUPLICATE BLOCK BELOW THIS LINE ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
