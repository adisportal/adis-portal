
    // ==========================================
    // authFetch: wraps the browser's fetch() and automatically attaches
    // the logged-in user's identity (x-user-id / x-session-id) so the
    // server's requireAuth middleware can verify every request.
    // Falls back to a plain, unauthenticated fetch if nobody is logged
    // in yet (e.g. the login screen itself, or maintenance status check).
    // ==========================================
    function authFetch(url, options = {}) {
        let savedUser = null;
        try { savedUser = JSON.parse(localStorage.getItem('currentUser')); } catch (e) {}

        const headers = Object.assign({}, options.headers || {});
        if (savedUser && savedUser.id && savedUser.sessionId) {
            headers['x-user-id'] = savedUser.id;
            headers['x-session-id'] = savedUser.sessionId;
        }
        return fetch(url, Object.assign({}, options, { headers }));
    }

    let touchStartX = 0; 
    let touchEndX = 0;

    // ==========================================
    // START: MINI-SNOWFLAKE AUTO-GENERATOR SETUP
    // ==========================================
    const SCHOOL_EPOCH = 1780000000; // Calibrated for 2026
    const MACHINE_ID = "1";          // Change to "2" or "3" for other computers
    let lastTimestamp = -1;
    let sequence = 0;
    
    function generateMiniSnowflake() {
        let currentTimestamp = Math.floor(Date.now() / 1000);
        let timeOffset = currentTimestamp - SCHOOL_EPOCH;     
        
        if (currentTimestamp === lastTimestamp) {
            sequence = (sequence + 1) % 10; // Loops 0-9 if clicked instantly
        } else {
            sequence = 0;
            lastTimestamp = currentTimestamp;
        }
        return `${timeOffset}${MACHINE_ID}${sequence}`;
    }

    // Helper function to auto-fill the form on your UI
    
    function assignNewId() {
        const generatedId = generateMiniSnowflake();
        const idInput = document.getElementById("s-id");
        
        if (idInput) {
            idInput.value = generatedId;
        }
    }
    
    // ==========================================
    // END: MINI-SNOWFLAKE AUTO-GENERATOR SETUP
    
    // ==========================================


    // Add this at the top of your script
    
    document.getElementById('togglePass').addEventListener('click', function() {
        const passField = document.getElementById('password');
        if (passField.type === 'password') {
            passField.type = 'text';
            this.classList.replace('fa-eye-slash', 'fa-eye');
        
        } else {
            
            passField.type = 'password';
            this.classList.replace('fa-eye', 'fa-eye-slash');
        }
    });
    
    window.onload = function() {
        const splash = document.getElementById('splash-screen');                
        if (splash) splash.style.display = 'none';
        const savedUser = localStorage.getItem('currentUser');
        if (savedUser) {
            try {
                const user = JSON.parse(savedUser);
                activateApp(user);
            } catch (e) {
                console.error("Storage parsing error", e);                
                document.getElementById('login-page').style.display = 'flex';
            }
        } else {
            // FIXED: Typo was 'doge'
            document.getElementById('login-page').style.display = 'flex';
        }
    };

    async function handleLogin() {
        const id = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value.trim();
        const btn = document.getElementById('loginBtn');
        if(!id || !password) return alert("Please fill all fields");

        btn.innerText = "Authenticating..."; btn.disabled = true;

        try {
            const res = await authFetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, password })
            });
            const result = await res.json();
            if (result.success) {
                localStorage.setItem('currentUser', JSON.stringify(Object.assign({}, result.user, { sessionId: result.sessionId })));
                activateApp(result.user);
            } else {
                alert("Login Failed: " + result.message);
            }
        } catch (e) { alert("Server Error"); }
        btn.innerText = "LOGIN"; btn.disabled = false;
    }

    function activateApp(user) {
        document.getElementById('login-page').style.display = 'none';
        document.getElementById('main-app').style.display = 'block';

        document.getElementById('user-display-name').innerText = user.name;
        document.getElementById('user-display-role').innerText = user.role.toUpperCase();
        document.getElementById('user-display-class').innerText = user.classId || 'N/A';
        document.getElementById('user-display-id').innerText = user.id;

        const schoolRow = document.getElementById('user-display-school-row');
        if (user.schoolName) {
            document.getElementById('user-display-school').innerText = user.schoolName;
            schoolRow.style.display = 'block';
        } else {
            schoolRow.style.display = 'none';
        }

        setupNav(user.role);
        loadDashboardBasedOnRole(user.role);
        loadAnnouncements(); // <--- Add this line here

        const savedPhoto = localStorage.getItem('userPhoto');
        if (savedPhoto) document.getElementById('user-avatar').innerHTML = `<img src="${savedPhoto}" style="width:100%;height:100%;object-fit:cover; border-radius:50%;">`;

        // ⬇️ ADD THIS LINE TO LOAD DROPDOWNS ON LOG IN 
        loadClassDropdown();
    }

    function logout() {
        // Best-effort: tell the server to invalidate this session too,
        // so a stolen/old session token can't keep working.
        authFetch('/api/logout', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('currentUser');
        location.reload();
    }

    function setupNav(role) {
        const navLinks = document.querySelectorAll('#nav-menu [data-role]');
        navLinks.forEach(link => {
            const allowedRoles = link.getAttribute('data-role').split(',');
            link.style.display = allowedRoles.includes(role) ? 'flex' : 'none';
        });

        const bottomManage = document.getElementById('nav-manage');
        if (bottomManage) {
            bottomManage.style.display = (role === 'admin' || role === 'teacher') ? 'block' : 'none';
        }
    }

    function loadDashboardBasedOnRole(role) {
        if(role === 'owner') { showSection('owner-panel', 'Owner Panel'); loadOwnerDashboard(); }
        else if(role === 'admin') showSection('admin-teachers', 'Admin Panel');
        else if(role === 'teacher') showSection('staff-students', 'Manage Students');
        else showSection('announcements', 'Home');
    }

    function showSection(id, title) {
        document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active-panel'));
        
        const panel = document.getElementById(id);
        if(panel) panel.classList.add('active-panel');
        
        document.getElementById('header-title').innerText = title;
        
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        
        const navMap = { 
            'announcements': 'nav-home', 
            'staff-students': 'nav-manage', 
            'admin-teachers': 'nav-manage', 
            'attendance': 'nav-att', 
            'fees': 'nav-fees', 
            'study-material': 'nav-mat' 
        };

        if(navMap[id]) document.getElementById(navMap[id]).classList.add('active');

        if (id === 'attendance') { loadClassDropdown(); loadAttendanceSection(); }
        if (id === 'admin-teachers') { loadClassDropdown(); loadTeachers(); loadClassesForManagement(); }
        if (id === 'student-directory') loadStudentDirectoryClasswise();
        if (id === 'fees') loadFees();
        if (id === 'study-material') loadMaterials();
        if (id === 'staff-students') { loadClassDropdown(); loadClassStudents(); }

        if(document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
    }

    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        const menuIcon = document.getElementById('menuIcon');

        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
        
        if (sidebar.classList.contains('active')) {
            menuIcon.classList.replace('fa-bars', 'fa-times');
        } else {
            menuIcon.classList.replace('fa-times', 'fa-bars');
        }
    }

    function hideSidebarOnCenterClick() {
        if (document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
    }

    document.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, {passive: true});
    document.addEventListener('touchend', e => { 
        touchEndX = e.changedTouches[0].screenX;
        if (touchEndX - touchStartX > 100 && touchStartX < 50) toggleSidebar(); 
        if (touchStartX - touchEndX > 100 && document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
    }, {passive: true});

    function editName() {
        const nameElement = document.getElementById('user-display-name');
        const newName = prompt("Enter new name:", nameElement.innerText);
        if (newName) {
            nameElement.innerText = newName;
            let user = JSON.parse(localStorage.getItem('currentUser'));
            user.name = newName;
            localStorage.setItem('currentUser', JSON.stringify(user));
            authFetch('/api/user/update-name', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: user.id, name: newName}) });
        }
    }

    function updateProfilePhoto(input) {
        if (input.files && input.files[0]) {
            const reader = new FileReader();
            reader.onload = e => {
                document.getElementById('user-avatar').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover; border-radius:50%;">`;
                localStorage.setItem('userPhoto', e.target.result);
            };
            reader.readAsDataURL(input.files[0]);
        }
    }

    async function loadMaterials() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const list = document.getElementById('material-list');
        list.innerHTML = "Fetching...";
        
        try {
            const res = await authFetch(`/api/materials/${user.classId}`);
            const data = await res.json();
            list.innerHTML = data.map(m => `
                <div class="card p-3 mb-2">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h6 class="mb-0 fw-bold">${m.title}</h6>
                            <small class="text-muted">${new Date(m.date).toLocaleDateString()}</small>
                        </div>
                        <a href="${m.link}" target="_blank" class="btn btn-sm btn-outline-primary">Open</a>
                    </div>
                </div>`).join('') || "No materials found.";
        } catch (e) { list.innerHTML = "Error."; }
    }

    // 1. Search Bar Logic
    function toggleSearchInput() {
        const input = document.getElementById('global-search');
        const isHidden = input.style.display === 'none';
        input.style.display = isHidden ? 'block' : 'none';
        if (isHidden) input.focus();
    }
    
    function executeSearch() {
        const query = document.getElementById('global-search').value.toLowerCase();
        const activePanel = document.querySelector('.active-panel');
  
        // Find all cards within the currently visible section
        
        const cards = activePanel.querySelectorAll('.card');
        cards.forEach(card => {
            const text = card.innerText.toLowerCase();
            // If the card contains the search text, show it; otherwise hide it
            card.style.display = text.includes(query) ? 'block' : 'none';
        });
    }
    // 2. Maintenance Mode Logic
    async function checkMaintenanceStatus() {
        try {
            const res = await authFetch('/api/maintenance/status');
            const data = await res.json();
            const overlay = document.getElementById('maintenance-screen');
            
            if (data.maintenance) {
                // Check if current user is admin (Admins should still see the app to turn it off)
                const user = JSON.parse(localStorage.getItem('currentUser'));
                if (user && user.role === 'admin') {
                    console.warn("Maintenance Mode is ON, but you are Admin.");
                } else {
                    overlay.style.display = 'flex';
                }
            } else {
                overlay.style.display = 'none';
            }
        } catch (e) { console.error("Status check failed", e); }
    }

// Run status check every 30 seconds
setInterval(checkMaintenanceStatus, 30000);
// Also run on load
checkMaintenanceStatus();

async function toggleMaintenanceMode() {
    const currentStatus = confirm("Switch Maintenance Mode status?");
    if(!currentStatus) return;

    // We'll ask the server what the current status is and flip it
    const res = await authFetch('/api/maintenance/status');
    const data = await res.json();
    
    const newStatus = !data.maintenance;
    
    const update = await authFetch('/api/admin/maintenance/toggle', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ status: newStatus })
    });
    
    const result = await update.json();
    alert(`Maintenance Mode is now ${result.maintenance ? 'ON' : 'OFF'}`);
    location.reload();
}


    async function uploadMaterial(btn) {
        const data = {
            title: document.getElementById('mat-title').value,
            link: document.getElementById('mat-link').value,
            classId: document.getElementById('mat-class').value
        };
        btn.disabled = true;
        const res = await authFetch('/api/materials', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
        if ((await res.json()).success) { alert("Material Added!"); btn.disabled = false; loadMaterials(); }
    }

    async function submitFeeUpdate(btn) {
        const data = { studentId: document.getElementById('fee-sid').value, amountPaid: parseFloat(document.getElementById('fee-paid').value) };
        btn.disabled = true;
        const res = await authFetch('/api/fees/update', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
        if ((await res.json()).success) { alert("Fee Updated!"); btn.disabled = false; }
    }

    async function loadFees() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const content = document.getElementById('fee-content');
        
        if (user.role === 'admin' || user.role === 'teacher') {
            document.getElementById('fee-admin-controls').style.display = 'block';
        }

        try {
            const res = await authFetch(`/api/student/profile/${user.id}`);
            const data = await res.json();
            if (data) {
                const remaining = data.totalFees - data.feesPaid;
                content.innerHTML = `
                    <div class="card bg-primary text-white p-4 text-center mb-3">
                        <small>REMAINING BALANCE</small>
                        <h1 class="fw-bold">₹${remaining}</h1>
                        <span class="badge bg-white text-primary">Status: ${remaining > 0 ? 'Pending' : 'Paid'}</span>
                    </div>
                    <div class="card p-3">
                        <div class="d-flex justify-content-between"><span>Total:</span><strong>₹${data.totalFees}</strong></div>
                        <div class="d-flex justify-content-between"><span>Paid:</span><strong class="text-success">₹${data.feesPaid}</strong></div>
                    </div>`;
            }
        } catch (e) { content.innerHTML = "Error loading fees."; }
    }

    document.getElementById('att-date-select').valueAsDate = new Date();

    async function loadAttendanceSection() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        if (user.role === 'admin' || user.role === 'teacher') {
            document.getElementById('teacher-attendance-controls').style.display = 'block';
            document.getElementById('student-attendance-view').style.display = 'none';
        } else {
            document.getElementById('teacher-attendance-controls').style.display = 'none';
            document.getElementById('student-attendance-view').style.display = 'block';
            loadStudentAttendanceView(user.id);
        }
    }

    async function loadClassAttendance() {
        const classId = document.getElementById('att-class-select').value;
        const date = document.getElementById('att-date-select').value;
        if (!classId || !date) return;
        const listContainer = document.getElementById('class-student-list');
        listContainer.innerHTML = "Loading...";
        const studentsRes = await authFetch(`/api/students/class/${classId}`);
        const students = await studentsRes.json();
        const attRes = await authFetch(`/api/attendance/${classId}/${date}`);
        const existingAtt = await attRes.json();
        const attMap = {};
        existingAtt.forEach(a => attMap[a.studentId] = a.status);
        listContainer.innerHTML = students.map(s => `
            <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                <span>${s.name}</span>
                <div>
                    <button class="btn btn-sm ${attMap[s.studentId] === 'Present' ? 'btn-success' : 'btn-outline-success'}" onclick="markAttendance('${s.studentId}', 'Present')">P</button>
                    <button class="btn btn-sm ${attMap[s.studentId] === 'Absent' ? 'btn-danger' : 'btn-outline-danger'}" onclick="markAttendance('${s.studentId}', 'Absent')">A</button>
                </div>
            </div>
        `).join('');
    }

    async function loadClassesForManagement() {
        const container = document.getElementById('classes-list-container');
        container.innerHTML = "Loading...";

        try {
            const res = await authFetch('/api/classes');
            const classes = await res.json();
            
            if (classes.length === 0) {
                container.innerHTML = "No classes found.";
                return;
            }

            container.innerHTML = classes.map(c => `
                <div class="card p-2 mb-2 d-flex justify-content-between align-items-center">
                    <span><strong>${c.className}</strong></span>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteClass('${c.className}')">Delete</button>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = "Error loading classes.";
        }
    }

    async function deleteClass(className) {
        if (!confirm(`Are you sure you want to delete ${className}?`)) return;

        const res = await authFetch(`/api/admin/classes/delete/${className}`, {
            method: 'DELETE'
        });
        
        const result = await res.json();
        alert(result.message);
        if (result.success) {
            loadClassesForManagement();
        }
    }

    async function transferStudents() {
        const fromClass = document.getElementById('transfer-from').value.trim();
        const toClass = document.getElementById('transfer-to').value.trim();
        
        if (!fromClass || !toClass) return alert("Enter both classes");
        if (!confirm(`Move all students from ${fromClass} to ${toClass}?`)) return;

        const res = await authFetch('/api/admin/transfer-class', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ fromClass, toClass })
        });
        
        const result = await res.json();
        alert(result.message);
    }

    async function loadStudentDirectoryClasswise() {
        const container = document.getElementById('student-directory-container');
        const user = JSON.parse(localStorage.getItem('currentUser'));
        container.innerHTML = "Loading...";

        try {
            const res = await authFetch('/api/teacher/students/list', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ role: user.role, classId: user.classId })
            });
            const students = await res.json();

            // 🔴 DEBUG LINE: Open your browser console (F12) to see what came back!
            console.log("Students array received from server:", students);
           
            if (!students || students.length === 0) {
                container.innerHTML = "No students found.";
                return;
            }

            const grouped = students.reduce((acc, student) => {
                const cls = student.classId || "Unassigned";
                if (!acc[cls]) acc[cls] = [];
                acc[cls].push(student);
                return acc;
            }, {});

            container.innerHTML = Object.keys(grouped).sort().map(className => `
                <div class="card p-3 mb-3">
                    <h5 class="fw-bold text-primary mb-3">Class: ${className}</h5>
                    ${grouped[className].map(s => `
                        <div class="d-flex justify-content-between border-bottom py-1">
                            <span>${s.name}</span>
                            <small class="text-muted">ID: ${s.studentId}</small>
                        </div>
                    `).join('')}
                </div>
            `).join('');

        } catch (e) {
            console.error("Directory component error:", e);
            container.innerHTML = "Error loading directory.";
        }
    }

    async function markAttendance(studentId, status) {
        const date = document.getElementById('att-date-select').value;
        const classId = document.getElementById('att-class-select').value;

        await authFetch('/api/attendance/update', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ studentId, date, status, classId }) 
        });

        loadClassAttendance();
    }

    async function loadStudentAttendanceView(studentId) {
        const res = await authFetch(`/api/student/attendance/${studentId}`);
        const records = await res.json();
        const listContainer = document.getElementById('student-attendance-list');
        const progressBar = document.getElementById('att-progress-bar');
        let presentDays = records.filter(r => r.status === 'Present').length;
        let totalDays = records.length;
        let percentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;
        progressBar.style.width = percentage + "%";
        progressBar.innerText = percentage + "%";
        progressBar.className = percentage >= 75 ? "progress-bar bg-success" : "progress-bar bg-danger";
        document.getElementById('att-stats').innerText = `${presentDays} Present / ${totalDays} Total Days`;
        listContainer.innerHTML = records.map(r => `
            <div class="card p-2 mb-1 d-flex justify-content-between">
                <span>${r.date}</span>
                <span class="badge ${r.status === 'Present' ? 'bg-success' : 'bg-danger'}">${r.status}</span>
            </div>
        `).join('') || "No records.";
    }

    async function addOrUpdateTeacher(btn) {
        const data = {
            name: document.getElementById('t-name').value,
            id: document.getElementById('t-id').value, 
            password: document.getElementById('t-pass').value,
            classId: document.getElementById('t-class').value
        };
        
        if(!data.id || !data.name) { 
            alert("Teacher ID and Name are required"); 
            if (result.success) {
                loadTeachers();
                // Add this to clear the form
                ['t-name', 't-id', 't-pass', 't-class'].forEach(id => document.getElementById(id).value = '');
            }

            return; 
        }
        
        btn.disabled = true;
        btn.innerText = "Saving...";

        try {
            const res = await authFetch('/api/admin/teachers/upsert', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
            
            const result = await res.json();
            alert(result.message);
            if (result.success) loadTeachers();
        } catch (error) {
            alert("API Connection Error. Please try again.");
        } finally {
            btn.disabled = false;
            btn.innerText = "Save Teacher";
        }
    }

    async function loadTeachers() {
        const list = document.getElementById('teacher-list');
        if (!list) return;
        list.innerHTML = "Fetching...";

        try {
            const res = await authFetch('/api/teachers');
            const data = await res.json();
                    if (data.length > 0) {
                        list.innerHTML = data.map(t => {
                            return `
                                 <div class="card p-2 mb-2 d-flex flex-row justify-content-between align-items-center shadow-sm"> 
                                      <div>
                                          <strong class="text-dark">${t.name}</strong> 
                                          <span class="text-muted">(${t.studentId})</span>
                                          <div class="small text-secondary">Class: ${t.classId || 'None'}</div>
                                      </div>
                                      <button class="btn btn-sm btn-outline-danger" onclick="deleteTeacher('${t.studentId}')">
                                           <i class="fas fa-trash-alt me-1"></i> Delete
                                      </button>
                                    </div>
                               `;
                        }).join(''); 
                        
                    } else { 
                        list.innerHTML = '<div class="card p-2 text-center text-muted">No teachers found.</div>'; 
                    } 
        } catch (error) { 
            console.error("Error displaying teachers:", error);
            list.innerHTML = '<div class="card p-2 text-center text-danger">Error loading teachers.</div>';
        }
    }



    async function deleteTeacher(teacherId) {
        if (!teacherId) return alert("Invalid Teacher ID");
        if (!confirm(`Are you sure you want to permanently delete teacher ID: ${teacherId}?`)) return;

        try {
            const res = await authFetch(`/api/admin/teachers/${teacherId}`, {
                method: 'DELETE'
            
            });
            
            const result = await res.json();
            
            if (result.success) {
                alert("Teacher account removed successfully.");
                loadTeachers(); // Refresh the list on screen automatically
            } else {
                alert("Failed to delete teacher account.");
            }
        } catch (error) {
            console.error("Delete network error:", error);
            alert("API Connection Error. Could not connect to server.");
        }
    }

    // ==========================================
    // OWNER PANEL: schools + school admins
    // ==========================================
    async function loadOwnerDashboard() {
        loadOwnerStats();
        loadSchools();
        loadAdmins();
    }

    async function loadOwnerStats() {
        const box = document.getElementById('owner-stats');
        if (!box) return;
        try {
            const res = await authFetch('/api/owner/stats');
            const s = await res.json();
            const stat = (label, value) => `
                <div class="col-6 col-md-3">
                    <div class="card p-3 text-center">
                        <div class="fw-bold fs-4">${value}</div>
                        <div class="small text-muted">${label}</div>
                    </div>
                </div>`;
            box.innerHTML = stat('Schools', s.schools) + stat('Admins', s.admins) + stat('Teachers', s.teachers) + stat('Students', s.students);
        } catch (e) {
            box.innerHTML = '';
        }
    }

    async function createSchool() {
        const nameInput = document.getElementById('school-name');
        const name = nameInput.value.trim();
        if (!name) return alert("Enter a school name");

        try {
            const res = await authFetch('/api/owner/schools/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const result = await res.json();
            alert(result.message);
            if (result.success) {
                nameInput.value = '';
                loadSchools();
                loadOwnerStats();
            }
        } catch (e) {
            alert("API Connection Error. Please try again.");
        }
    }

    async function loadSchools() {
        const list = document.getElementById('schools-list-container');
        const select = document.getElementById('a-school');
        if (!list) return;
        list.innerHTML = "Loading...";

        try {
            const res = await authFetch('/api/owner/schools');
            const schools = await res.json();

            if (schools.length === 0) {
                list.innerHTML = '<div class="card p-2 text-center text-muted">No schools yet. Create one above.</div>';
            } else {
                list.innerHTML = schools.map(s => `
                    <div class="card p-2 mb-2 d-flex flex-row justify-content-between align-items-center shadow-sm">
                        <div>
                            <strong class="text-dark">${s.name}</strong>
                            <span class="text-muted">(${s.schoolId})</span>
                            <div class="small text-secondary">${s.adminCount} admin · ${s.teacherCount} teachers · ${s.studentCount} students</div>
                        </div>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteSchool('${s.schoolId}')">
                            <i class="fas fa-trash-alt me-1"></i> Delete
                        </button>
                    </div>
                `).join('');
            }

            if (select) {
                const current = select.value;
                select.innerHTML = '<option value="">Select School</option>' +
                    schools.map(s => `<option value="${s.schoolId}">${s.name} (${s.schoolId})</option>`).join('');
                if (current) select.value = current;
            }
        } catch (e) {
            console.error("Error loading schools:", e);
            list.innerHTML = '<div class="card p-2 text-center text-danger">Error loading schools.</div>';
        }
    }

    async function deleteSchool(schoolId) {
        if (!confirm(`Delete school ${schoolId}? This only works if it has no admins, teachers, or students left.`)) return;

        try {
            const res = await authFetch(`/api/owner/schools/${schoolId}`, { method: 'DELETE' });
            const result = await res.json();
            alert(result.message);
            if (result.success) {
                loadSchools();
                loadOwnerStats();
            }
        } catch (e) {
            alert("API Connection Error. Please try again.");
        }
    }

    async function addOrUpdateAdmin(btn) {
        const data = {
            name: document.getElementById('a-name').value.trim(),
            id: document.getElementById('a-id').value.trim(),
            password: document.getElementById('a-pass').value,
            schoolId: document.getElementById('a-school').value
        };

        if (!data.id || !data.name) return alert("Admin ID and Name are required");
        if (!data.schoolId) return alert("Select a school for this admin");

        btn.disabled = true;
        btn.innerText = "Saving...";

        try {
            const res = await authFetch('/api/owner/admins/upsert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            alert(result.message);
            if (result.success) {
                ['a-name', 'a-id', 'a-pass'].forEach(id => document.getElementById(id).value = '');
                loadAdmins();
                loadSchools();
                loadOwnerStats();
            }
        } catch (e) {
            alert("API Connection Error. Please try again.");
        } finally {
            btn.disabled = false;
            btn.innerText = "Save Admin";
        }
    }

    async function loadAdmins() {
        const list = document.getElementById('admins-list-container');
        if (!list) return;
        list.innerHTML = "Fetching...";

        try {
            const res = await authFetch('/api/owner/admins');
            const admins = await res.json();

            if (admins.length > 0) {
                list.innerHTML = admins.map(a => `
                    <div class="card p-2 mb-2 d-flex flex-row justify-content-between align-items-center shadow-sm">
                        <div>
                            <strong class="text-dark">${a.name}</strong>
                            <span class="text-muted">(${a.studentId})</span>
                            <div class="small text-secondary">${a.schoolName}</div>
                        </div>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteAdmin('${a.studentId}')">
                            <i class="fas fa-trash-alt me-1"></i> Delete
                        </button>
                    </div>
                `).join('');
            } else {
                list.innerHTML = '<div class="card p-2 text-center text-muted">No admins yet.</div>';
            }
        } catch (e) {
            console.error("Error loading admins:", e);
            list.innerHTML = '<div class="card p-2 text-center text-danger">Error loading admins.</div>';
        }
    }

    async function deleteAdmin(adminId) {
        if (!adminId) return alert("Invalid Admin ID");
        if (!confirm(`Are you sure you want to permanently delete admin ID: ${adminId}?`)) return;

        try {
            const res = await authFetch(`/api/owner/admins/${adminId}`, { method: 'DELETE' });
            const result = await res.json();
            if (result.success) {
                alert("Admin account removed successfully.");
                loadAdmins();
                loadOwnerStats();
            } else {
                alert("Failed to delete admin account.");
            }
        } catch (error) {
            console.error("Delete network error:", error);
            alert("API Connection Error. Could not connect to server.");
        }
    }

    
    async function addOrUpdateStudent(btn) {
        let studentIdInput = document.getElementById('s-id').value.trim();

        // 1. AUTO-GENERATOR: If the field is empty, create a Snowflake ID instantly!
        if (!studentIdInput || studentIdInput === "") {
            studentIdInput = generateMiniSnowflake();
            document.getElementById('s-id').value = studentIdInput; 
        }

        const data = {
            name: document.getElementById('s-name').value.trim(),
            id: studentIdInput, 
            password: document.getElementById('s-pass').value,
            classId: document.getElementById('s-class').value.trim(),
            totalFees: parseFloat(document.getElementById('s-fees').value) || 0
        };

        // 2. CLEAN VALIDATION: Check fields BEFORE touching network parameters
        if (!data.id || !data.name || !data.classId) {
            alert("Student ID, Name, and Class are completely required!");
            return; // Stops here safely if something is missing
        }

        // Disable button to prevent double-clicks
        btn.disabled = true;
        btn.innerText = "Saving...";

        try {
            console.log("Sending data to backend payload:", data);
            
            const res = await authFetch('/api/teacher/students/upsert', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });


            const result = await res.json();
            alert(result.message);
            
            if (result.success) {
                // Refresh directory or list management if they exist
                if (typeof loadClassStudents === "function") loadClassStudents();
                if (typeof loadStudentDirectoryClasswise === "function") loadStudentDirectoryClasswise();
            
                // Clear out form inputs for the next entry
                ['s-name', 's-id', 's-pass', 's-class', 's-fees'].forEach(id => {
                    const element = document.getElementById(id);
                    if (element) element.value = '';
                });
            }
        } catch (error) {
            console.error("Submission Error Details:", error);
            alert("API Connection Error: " + error.message);
        } finally {
            
            btn.disabled = false;
            btn.innerText = "Save Student";
        }
    }


    async function loadClassStudents() {
        const classId = document.getElementById('search-class').value;
        const list = document.getElementById('student-list-mgmt');
        if(!classId) { list.innerHTML = "Enter a class to search."; return; }
        list.innerHTML = "Loading...";
        const res = await authFetch(`/api/students/class/${classId}`);
        const data = await res.json();
        list.innerHTML = data.map(s => `
            <div class="d-flex justify-content-between align-items-center border-bottom py-1">
                <span>${s.name} (${s.studentId})</span>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteStudent('${s.studentId}')">Delete</button>
            </div>
        `).join('') || "No students found.";
    }

    async function deleteStudent(id) {
        if(!confirm("Are you sure?")) return;
        await authFetch(`/api/teacher/students/${id}`, { method: 'DELETE' });
        loadClassStudents();
    }

    async function createClass() {
        const className = document.getElementById('new-class-name').value.trim();
        if (!className) return alert("Enter class name");

        const res = await authFetch('/api/admin/classes/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ className })
        });
        
        const result = await res.json();
        alert(result.message);
        if (result.success) {
            document.getElementById('new-class-name').value = '';
            loadClassDropdown();
        }
    }

    // --- UPGRADED CLASS DROPDOWN SYSTEM ---
    async function loadClassDropdown() {
      const studentSelect = document.getElementById('s-class');
      const attSelect = document.getElementById('att-class-select');
    
      // If neither dropdown is on the current screen view, exit early
      if (!studentSelect && !attSelect) return;

      try {
        const res = await authFetch('/api/classes');
        const classes = await res.json();
        
        let optionsHtml = '<option value="">-- Select Class --</option>';
    
        if (Array.isArray(classes) && classes.length > 0) {
          classes.forEach(c => {
            // Safeguard against string arrays or object collections from your API
            const className = typeof c === 'object' && c !== null ? (c.className || c.name) : c;
            if (className) {
              optionsHtml += `<option value="${className}">${className}</option>`;

            }
          });
        } else {
          optionsHtml = '<option value="">No classes registered</option>';
        }
        
        // Update both student panel and attendance dropdown targets automatically
        if (studentSelect) studentSelect.innerHTML = optionsHtml;
        if (attSelect) attSelect.innerHTML = optionsHtml;
        
      } catch (e) {
        console.error("Error populating system class dropdowns:", e);
        if (studentSelect) studentSelect.innerHTML = '<option value="">Error loading</option>';
      }
    }

     function clearAppData() {
       if (confirm("Are you sure? This will clear local cached data.")) {
         localStorage.clear(); // Clears out your user authentication profile
         alert("Cache Cleared!");
         location.reload();
       }
     }


function clearAppData() {
    if (confirm("Are you sure? This will clear local cached data.")) {
        alert("Cache Cleared!");
    }
}

// --- NEW ANNOUNCEMENT FEATURES START HERE ---
    async function loadAnnouncements() {
        const user = JSON.parse(localStorage.getItem("currentUser"));
        const container = document.getElementById("announcement-list");
        const postBox = document.getElementById("announcement-poster");

        // Show posting box for authorized roles
        if (user && (user.role === "admin" || user.role === "teacher")) {
            postBox.style.display = "block";
        }

        // Show loader if container is empty
        if (!container.innerHTML || container.innerHTML.includes("loader")) {
            container.innerHTML = '<div class="text-center p-3"><div class="loader" style="margin:auto; width:20px; height:20px; border-width:2px;"></div></div>';
        }

        try {
            const res = await authFetch("/api/announcements");
            const data = await res.json();
        
            if (!data || data.length === 0) {
                container.innerHTML = '<div class="card p-4 text-center text-muted">No announcements yet.</div>';
                return;
            }

     // CORRECTED: Added missing backticks and balanced all quotes
                container.innerHTML = data.map(ann => `
            <div class="card mb-3 p-0 overflow-hidden shadow-sm">
                ${ann.imageUrl ? `
                    <img src="${ann.imageUrl}" 
                         onerror="this.style.display='none'" 
                         style="width:100%; max-height:300px; object-fit:cover; display:block;">
                ` : ""}
                <div class="p-3">
                    <div class="d-flex justify-content-between align-items-start">
                        <div style="flex-grow: 1;">
                            <p class="mb-1" style="white-space: pre-wrap;">${ann.text}</p>
                            <small class="text-muted">
                                <i class="far fa-clock me-1"></i> ${new Date(ann.date).toLocaleString()}
                            </small>
                        </div>
                        ${(user && (user.role === "admin" || user.role === "teacher")) ? `
                            <button class="btn btn-sm btn-light ms-2" onclick="deleteAnnouncement('${ann._id}')" title="Delete Post">
                                <i class="fas fa-trash text-danger"></i>
                            </button>
                        ` : ""}
                    </div>
                </div>
            </div>
        `).join("");
        } catch (e) {
            console.error("Announcement load error:", e);
            // CORRECTED: Fixed the missing opening backtick/quote here
            container.innerHTML = `<div class="card p-4 text-center text-danger"><i class="fas fa-exclamation-circle mb-2"></i><br>Failed to load announcements.</div>`;
        }
    }


    async function postAnnouncement(btn) {
        const text = document.getElementById('ann-text').value;
        const fileInput = document.getElementById('ann-image');
        
        if (!text && !fileInput.files[0]) return alert("Please add text or an image");

        btn.disabled = true;
        btn.innerText = "Posting...";

        const formData = new FormData();
        formData.append('text', text);
        if (fileInput.files[0]) formData.append('image', fileInput.files[0]);

        try {
            const res = await authFetch('/api/announcements', {
                method: 'POST',
                body: formData 
            });
            const result = await res.json();
            if (result.success) {
                document.getElementById('ann-text').value = '';
                fileInput.value = '';
                loadAnnouncements();
            }
        } catch (e) {
            alert("Upload failed");
        } finally {
            btn.disabled = false;
            btn.innerText = "Post";
        }
    }

    async function deleteAnnouncement(id) {
        if (!confirm("Delete this post?")) return;
        await authFetch(`/api/announcements/${id}`, { method: 'DELETE' });
        loadAnnouncements();
    }
 
