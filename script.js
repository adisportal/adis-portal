let currentUser = null;

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('active');
    document.getElementById('overlay').classList.toggle('active');
}

async function handleLogin() {
    const id = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const btn = document.getElementById('loginBtn');

    btn.innerText = "Authenticating...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id, password })
        });
        const data = await res.json();

        if (data.success) {
            currentUser = data.user;
            document.getElementById('login-page').style.display = 'none';
            document.getElementById('main-app').style.display = 'block';
            document.getElementById('user-display-name').innerText = currentUser.name;
            setupNav(currentUser.role);
            loadAnnouncements();
        } else {
            alert("Invalid Credentials");
            btn.innerText = "LOGIN"; btn.disabled = false;
        }
    } catch (e) { alert("Server Offline. Start Termux!"); btn.innerText = "LOGIN"; btn.disabled = false; }
}

function setupNav(role) {
    const menu = document.getElementById('nav-menu');
    const isStaff = (role === 'teacher' || role === 'admin');
    
    let html = `
        <div class="nav-link active-link" onclick="showSection('announcements', 'Home')"><i class="fas fa-home me-3"></i> Home</div>
        <div class="nav-link" onclick="showSection('attendance', 'Attendance')"><i class="fas fa-user-check me-3"></i> Attendance</div>
    `;

    if (isStaff) {
        html += `<div class="nav-link" onclick="showSection('manage-students', 'Students')"><i class="fas fa-users me-3"></i> Manage Students</div>`;
        document.getElementById('teacher-ann-form').style.display = 'block';
        document.getElementById('teacher-att-view').style.display = 'block';
    } else {
        document.getElementById('student-att-view').style.display = 'block';
    }
    menu.innerHTML = html;
}

function showSection(id, title) {
    document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active-panel'));
    document.getElementById(id).classList.add('active-panel');
    document.getElementById('header-title').innerText = title;
    
    if (id === 'attendance') {
        if(currentUser.role === 'student') loadStudentAttendance();
        else loadTeacherStudentList();
    }
    if (id === 'manage-students') loadAdminStudentList();
    if (id === 'announcements') loadAnnouncements();

    const sidebar = document.getElementById('sidebar');
    if(sidebar.classList.contains('active')) toggleSidebar();
}

// --- FEATURE LOGIC ---

async function postAnn() {
    const text = document.getElementById('ann-input').value;
    await fetch('/api/announcements', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ text, teacher: currentUser.name })
    });
    document.getElementById('ann-input').value = "";
    loadAnnouncements();
}

async function loadAnnouncements() {
    const res = await fetch('/api/announcements');
    const data = await res.json();
    document.getElementById('ann-list').innerHTML = data.map(a => `
        <div class="card p-3 mb-2 border-0 shadow-sm">
            <small class="text-primary fw-bold">${a.teacher} • ${a.date}</small>
            <p class="mb-0">${a.text}</p>
        </div>
    `).join('');
}

async function registerStudent() {
    const payload = {
        studentId: document.getElementById('reg-id').value,
        name: document.getElementById('reg-name').value,
        studentClass: document.getElementById('reg-class').value,
        password: document.getElementById('reg-pass').value
    };
    await fetch('/api/students', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    alert("Student Saved!");
    loadAdminStudentList();
}

async function loadAdminStudentList() {
    const res = await fetch('/api/students');
    const students = await res.json();
    document.getElementById('admin-student-list').innerHTML = students.map(s => `
        <div class="card p-2 mb-2 d-flex flex-row justify-content-between align-items-center border-0 shadow-sm">
            <span>${s.name} (${s.studentId})</span>
            <button class="btn btn-outline-danger btn-sm" onclick="deleteStudent('${s.studentId}')">Delete</button>
        </div>
    `).join('');
}

async function deleteStudent(id) {
    if(confirm("Are you sure?")) {
        await fetch(`/api/students/${id}`, { method: 'DELETE' });
        loadAdminStudentList();
    }
}

async function loadTeacherStudentList() {
    const res = await fetch('/api/students');
    const students = await res.json();
    document.getElementById('teacher-student-list').innerHTML = students.map(s => `
        <div class="d-flex justify-content-between p-2 border-bottom">
            <span>${s.name}</span>
            <div>
                <button class="btn btn-sm btn-success" onclick="mark('${s.studentId}','Present')">P</button>
                <button class="btn btn-sm btn-danger" onclick="mark('${s.studentId}','Absent')">A</button>
            </div>
        </div>
    `).join('');
}

async function mark(id, status) {
    const date = document.getElementById('att-date').value;
    if(!date) return alert("Select Date!");
    await fetch('/api/attendance', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ studentId: id, date, status })
    });
}

async function loadStudentAttendance() {
    const res = await fetch(`/api/attendance/${currentUser.id}`);
    const data = await res.json();
    const total = data.length;
    const present = data.filter(d => d.status === 'Present').length;
    const per = total > 0 ? Math.round((present / total) * 100) : 0;
    
    const display = document.getElementById('att-per-display');
    display.innerText = per + "%";
    display.style.color = per >= 75 ? "#198754" : "#dc3545";

    document.getElementById('att-history-list').innerHTML = data.map(d => `
        <div class="card p-2 mb-1 d-flex flex-row justify-content-between border-0 shadow-sm">
            <span>${d.date}</span>
            <span class="${d.status === 'Present' ? 'text-success' : 'text-danger'} fw-bold">${d.status}</span>
        </div>
    `).reverse().join('');
}
