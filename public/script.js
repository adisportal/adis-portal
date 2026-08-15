
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

        return fetch(url, Object.assign({}, options, { headers })).then(res => {
            // Global 401 handling: a session that's expired or was
            // invalidated (e.g. logged in elsewhere) should bounce back
            // to the login screen instead of leaving broken, half-loaded
            // panels on screen. Login itself is exempt since a bad
            // password legitimately 401s and should just show the normal
            // "Invalid Credentials" message, not force a reload.
            if (res.status === 401 && url !== '/api/login') {
                localStorage.removeItem('currentUser');
                alert('Your session has expired. Please log in again.');
                location.reload();
                return new Promise(() => {}); // reload is underway; stop here
            }
            return res;
        });
    }

    let touchStartX = 0; 
    let touchEndX = 0;
    let notifPollInterval = null;
    let chatBadgePollInterval = null;
    let chatMessagePoll = null;
    let currentThreadId = null;
    let currentThreads = [];
    let currentOversightThreads = [];

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
    
    document.addEventListener('DOMContentLoaded', async function() {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.style.display = 'none';

        const savedUser = localStorage.getItem('currentUser');
        if (!savedUser) {
            document.getElementById('login-page').style.display = 'flex';
            return;
        }

        let user;
        try {
            user = JSON.parse(savedUser);
        } catch (e) {
            console.error("Storage parsing error", e);
            localStorage.removeItem('currentUser');
            document.getElementById('login-page').style.display = 'flex';
            return;
        }

        // Don't trust a cached session blindly on app open — confirm with
        // the server first (it may have expired, or been invalidated by a
        // login elsewhere). This matters most for the Android WebView
        // wrapper: closing and reopening it used to silently show a
        // "dashboard" that broke on the very first data request.
        try {
            const res = await fetch(`/api/verify-session?userId=${encodeURIComponent(user.id)}&sessionId=${encodeURIComponent(user.sessionId)}`);
            const data = await res.json();
            if (data.active) {
                activateApp(user);
            } else {
                localStorage.removeItem('currentUser');
                document.getElementById('login-page').style.display = 'flex';
            }
        } catch (e) {
            // Network hiccup / cold start (Render free tier can take 50s+
            // to wake up) — fall back to the cached session rather than
            // forcing a re-login for something that isn't the user's
            // fault. A genuinely dead session will still be caught by the
            // global 401 handler in authFetch on the next real request.
            console.error("Session verification failed, using cached session:", e);
            activateApp(user);
        }
    });

    // Safety net: however unlikely, never leave the splash screen up
    // forever (a slow/blocked image, a stuck service worker, anything).
    // Force it down after a few seconds so the user can always at least
    // reach the login screen.
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        const mainApp = document.getElementById('main-app');
        if (splash && splash.style.display !== 'none') {
            splash.style.display = 'none';
            if (!mainApp || mainApp.style.display !== 'block') {
                document.getElementById('login-page').style.display = 'flex';
            }
        }
    }, 6000);

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
        } catch (e) {
            console.error("Login request failed:", e);
            alert("Couldn't reach the server. If the app has been idle a while, it may still be waking up (free hosting tier) — please wait ~30 seconds and try again.");
        }
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

        loadNotifications();
        if (notifPollInterval) clearInterval(notifPollInterval);
        notifPollInterval = setInterval(loadNotifications, 30000);

        if (['teacher', 'admin', 'parent', 'owner'].includes(user.role)) {
            loadChatBadge();
            if (chatBadgePollInterval) clearInterval(chatBadgePollInterval);
            chatBadgePollInterval = setInterval(loadChatBadge, 30000);
        }
    }

    function logout() {
        // Best-effort: tell the server to invalidate this session too,
        // so a stolen/old session token can't keep working.
        authFetch('/api/logout', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('currentUser');
        if (notifPollInterval) clearInterval(notifPollInterval);
        if (chatBadgePollInterval) clearInterval(chatBadgePollInterval);
        if (chatMessagePoll) clearInterval(chatMessagePoll);
        location.reload();
    }

    function setupNav(role) {
        const navLinks = document.querySelectorAll('#nav-menu [data-role]');
        navLinks.forEach(link => {
            const allowedRoles = link.getAttribute('data-role').split(',');
            link.style.display = allowedRoles.includes(role) ? 'flex' : 'none';
        });

        const bottomLinks = document.querySelectorAll('.bottom-nav [data-role]');
        bottomLinks.forEach(link => {
            const allowedRoles = link.getAttribute('data-role').split(',');
            link.style.display = allowedRoles.includes(role) ? 'block' : 'none';
        });
    }

    function loadDashboardBasedOnRole(role) {
        if(role === 'owner') { showSection('owner-panel', 'Owner Panel'); loadOwnerDashboard(); }
        else if(role === 'admin') showSection('admin-teachers', 'Admin Panel');
        else if(role === 'teacher') showSection('staff-students', 'Manage Students');
        else if(role === 'parent') showSection('parent-panel', 'My Children');
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
            'study-material': 'nav-mat',
            'timetable': 'nav-tt',
            'chat-hub': 'nav-chats'
        };

        if(navMap[id] && document.getElementById(navMap[id])) document.getElementById(navMap[id]).classList.add('active');

        if (id === 'attendance') { loadClassDropdown(); loadAttendanceSection(); }
        if (id === 'admin-teachers') { loadClassDropdown(); loadTeachers(); loadClassesForManagement(); }
        if (id === 'student-directory') loadStudentDirectoryClasswise();
        if (id === 'fees') loadFees();
        if (id === 'study-material') loadMaterials();
        if (id === 'staff-students') { loadClassDropdown(); loadClassStudents(); }
        if (id === 'parent-panel') loadParentChildren();
        if (id === 'feedback-inbox') loadFeedbackInbox();
        if (id === 'timetable') loadTimetableSection();
        if (id === 'admin-teachers') loadParents();
        if (id === 'chat-hub') loadChatHub();
        if (id === 'oversight-panel') loadOversightPanel();

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
        if ((await res.json()).success) { alert("Fee Updated!"); btn.disabled = false; loadFeeOverduePanel(); }
        else btn.disabled = false;
    }

    async function submitFeeDueDate(btn) {
        const studentId = document.getElementById('fee-due-sid').value.trim();
        const feeDueDate = document.getElementById('fee-due-date').value;
        if (!studentId || !feeDueDate) return alert("Student ID and a due date are both required.");
        btn.disabled = true;
        try {
            const res = await authFetch('/api/admin/fees/set-due-date', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ studentId, feeDueDate })
            });
            const result = await res.json();
            if (result.success) { alert("Due date set."); loadFeeOverduePanel(); } else alert(result.message || "Couldn't set due date.");
        } catch (e) { alert("Couldn't set due date."); }
        btn.disabled = false;
    }

    async function loadFeeOverduePanel() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const panel = document.getElementById('fee-overdue-panel');
        if (user.role !== 'admin') { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        panel.innerHTML = "Loading due/overdue fees...";
        try {
            const res = await authFetch('/api/admin/fees/overdue');
            const list = await res.json();
            if (list.length === 0) { panel.innerHTML = `<div class="card p-3 text-muted small">No fees due in the next 3 days. 🎉</div>`; return; }
            panel.innerHTML = `
                <div class="card p-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h6 class="mb-0">Due &amp; Overdue Fees</h6>
                        <button class="btn btn-sm btn-outline-danger" onclick="remindAllFees(this)">Remind All</button>
                    </div>
                    ${list.map(s => `
                        <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
                            <div>
                                <div>${escapeHtml(s.name)} <span class="text-muted small">(${escapeHtml(s.classId || '')})</span></div>
                                <div class="small ${s.isOverdue ? 'text-danger' : 'text-muted'}">₹${s.remaining} · ${s.isOverdue ? 'overdue since' : 'due'} ${s.feeDueDate}</div>
                            </div>
                            <button class="btn btn-sm btn-outline-primary" onclick="remindOneFee('${s.studentId}', this)">Remind</button>
                        </div>
                    `).join('')}
                </div>`;
        } catch (e) { panel.innerHTML = ''; }
    }

    async function remindOneFee(studentId, btn) {
        btn.disabled = true;
        try {
            const res = await authFetch(`/api/admin/fees/remind/${studentId}`, { method: 'POST' });
            const result = await res.json();
            btn.innerText = result.sent ? 'Sent ✓' : 'Skipped';
        } catch (e) { btn.innerText = 'Error'; }
    }

    async function remindAllFees(btn) {
        btn.disabled = true;
        const original = btn.innerText;
        btn.innerText = 'Sending...';
        try {
            const res = await authFetch('/api/admin/fees/remind-all', { method: 'POST' });
            const result = await res.json();
            btn.innerText = `Sent ${result.sentCount}${result.skippedCount ? `, skipped ${result.skippedCount}` : ''}`;
        } catch (e) { btn.innerText = original; btn.disabled = false; }
    }

    async function loadFees() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const content = document.getElementById('fee-content');

        if (user.role === 'admin' || user.role === 'teacher') {
            document.getElementById('fee-admin-controls').style.display = 'block';
        }
        if (user.role === 'admin') {
            document.getElementById('fee-due-date-controls').style.display = 'block';
        }
        loadFeeOverduePanel();

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
                        ${data.feeDueDate ? `<div class="d-flex justify-content-between"><span>Due date:</span><strong>${data.feeDueDate}</strong></div>` : ''}
                    </div>`;
            }
        } catch (e) { content.innerHTML = "Error loading fees."; }
    }

    // ==========================================
    // TIMETABLE (Phase 3)
    // ==========================================
    const TT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function renderTimetableGrid(slots, editable) {
        if (slots.length === 0) return `<div class="card p-3 text-muted small">No periods scheduled yet.</div>`;
        const byDay = {};
        TT_DAYS.forEach(d => byDay[d] = []);
        slots.forEach(s => { if (byDay[s.day]) byDay[s.day].push(s); });
        return TT_DAYS.filter(d => byDay[d].length > 0).map(day => `
            <div class="card p-2 mb-2">
                <div class="fw-bold small mb-1">${day}</div>
                ${byDay[day].map(s => `
                    <div class="d-flex justify-content-between align-items-center py-1 border-bottom">
                        <div>
                            <span class="badge bg-secondary me-2">P${s.period}</span>
                            <strong>${escapeHtml(s.subject)}</strong>
                            ${s.startTime ? `<span class="text-muted small ms-1">${s.startTime}${s.endTime ? '–' + s.endTime : ''}</span>` : ''}
                            ${s.teacherName ? `<div class="text-muted small">${escapeHtml(s.teacherName)}</div>` : ''}
                        </div>
                        ${editable ? `<button class="btn btn-sm btn-outline-danger" onclick="deleteTimetableSlot('${s._id}')"><i class="fas fa-trash"></i></button>` : ''}
                    </div>
                `).join('')}
            </div>
        `).join('');
    }

    async function loadTimetableSection() {
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const content = document.getElementById('timetable-content');
        const adminControls = document.getElementById('timetable-admin-controls');

        if (user.role === 'admin') {
            adminControls.style.display = 'block';
            await populateTimetableAdminForm();
            loadClassTimetable();
            return;
        }
        adminControls.style.display = 'none';

        if (user.role === 'parent') {
            try {
                const res = await authFetch('/api/parent/children');
                const children = await res.json();
                if (children.length === 0) { content.innerHTML = `<p class="text-muted small">No linked children yet.</p>`; return; }
                content.innerHTML = `
                    <select id="tt-parent-child-select" class="form-select mb-3" onchange="loadParentChildTimetable()">
                        ${children.map(c => `<option value="${c.studentId}">${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                    <div id="tt-parent-child-grid">Loading...</div>`;
                loadParentChildTimetable();
            } catch (e) { content.innerHTML = "Error loading children."; }
            return;
        }

        // Teacher or student: role-aware "my schedule".
        content.innerHTML = "Loading timetable...";
        try {
            const res = await authFetch('/api/timetable/mine');
            const slots = await res.json();
            content.innerHTML = renderTimetableGrid(slots, false);
        } catch (e) { content.innerHTML = "Error loading timetable."; }
    }

    async function loadParentChildTimetable() {
        const studentId = document.getElementById('tt-parent-child-select').value;
        const grid = document.getElementById('tt-parent-child-grid');
        grid.innerHTML = "Loading...";
        try {
            const res = await authFetch(`/api/timetable/mine?studentId=${studentId}`);
            const slots = await res.json();
            grid.innerHTML = renderTimetableGrid(slots, false);
        } catch (e) { grid.innerHTML = "Error loading timetable."; }
    }

    async function populateTimetableAdminForm() {
        const daySelect = document.getElementById('tt-day');
        if (daySelect.options.length === 0) {
            daySelect.innerHTML = TT_DAYS.map(d => `<option value="${d}">${d}</option>`).join('');
        }
        const classSelect = document.getElementById('tt-class-select');
        try {
            const res = await authFetch('/api/classes');
            const classes = await res.json();
            classSelect.innerHTML = classes.map(c => `<option value="${c.className}">${escapeHtml(c.className)}</option>`).join('');
        } catch (e) {}
        const teacherSelect = document.getElementById('tt-teacher');
        try {
            const res = await authFetch('/api/teachers');
            const teachers = await res.json();
            teacherSelect.innerHTML = `<option value="">No teacher</option>` +
                teachers.map(t => `<option value="${t.studentId}">${escapeHtml(t.name)}</option>`).join('');
        } catch (e) {}
    }

    async function loadClassTimetable() {
        const classId = document.getElementById('tt-class-select').value;
        const content = document.getElementById('timetable-content');
        if (!classId) { content.innerHTML = `<p class="text-muted small">No classes yet — create one under Manage first.</p>`; return; }
        content.innerHTML = "Loading...";
        try {
            const res = await authFetch(`/api/timetable/class/${classId}`);
            const slots = await res.json();
            content.innerHTML = renderTimetableGrid(slots, true);
        } catch (e) { content.innerHTML = "Error loading timetable."; }
    }

    async function addTimetableSlot() {
        const classId = document.getElementById('tt-class-select').value;
        const day = document.getElementById('tt-day').value;
        const period = document.getElementById('tt-period').value;
        const subject = document.getElementById('tt-subject').value.trim();
        const startTime = document.getElementById('tt-start').value;
        const endTime = document.getElementById('tt-end').value;
        const teacherId = document.getElementById('tt-teacher').value;
        if (!classId || !day || !period || !subject) return alert("Class, day, period, and subject are required.");
        try {
            const res = await authFetch('/api/admin/timetable/slot', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ classId, day, period, subject, startTime, endTime, teacherId })
            });
            const result = await res.json();
            if (!result.success) return alert(result.message || "Couldn't add period.");
            document.getElementById('tt-period').value = '';
            document.getElementById('tt-subject').value = '';
            loadClassTimetable();
        } catch (e) { alert("Couldn't add period."); }
    }

    async function deleteTimetableSlot(id) {
        if (!confirm("Remove this period from the timetable?")) return;
        try {
            const res = await authFetch(`/api/admin/timetable/slot/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (result.success) loadClassTimetable(); else alert("Couldn't remove period.");
        } catch (e) { alert("Couldn't remove period."); }
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
        loadOwnerAnalytics();
        loadSchools();
        loadAdmins();
    }

    async function loadOwnerAnalytics() {
        const box = document.getElementById('owner-analytics');
        if (!box) return;
        try {
            const res = await authFetch('/api/owner/analytics');
            const data = await res.json();

            const maxCount = Math.max(1, ...data.growth.map(m => Math.max(m.students, m.staff)));
            const growthBars = data.growth.map(m => `
                <div class="growth-bar-col">
                    <div style="display:flex; gap:2px; align-items:flex-end; width:100%; height:100%;">
                        <div class="growth-bar-fill" style="height:${(m.students / maxCount) * 100}%; background: var(--teal); flex:1;" title="${m.students} new students"></div>
                        <div class="growth-bar-fill" style="height:${(m.staff / maxCount) * 100}%; background: var(--amber); flex:1;" title="${m.staff} new teachers/parents"></div>
                    </div>
                    <div class="growth-bar-label">${m.label}</div>
                </div>
            `).join('');

            const incomeRows = data.income.length === 0 ? `<p class="text-muted small mb-0">No schools yet.</p>` : data.income.map(i => `
                <div class="income-row">
                    <div style="flex:1;">
                        <div>${i.schoolName}</div>
                        <div class="income-pct-bar"><div class="income-pct-fill" style="width:${i.collectionPct ?? 0}%;"></div></div>
                    </div>
                    <div class="text-end ms-3">
                        <div class="fw-bold">${i.collectionPct !== null ? i.collectionPct + '%' : '—'}</div>
                        <div class="text-muted" style="font-size:0.7rem;">₹${i.feesPaid.toLocaleString()} / ₹${i.totalFees.toLocaleString()}</div>
                    </div>
                </div>
            `).join('');

            box.innerHTML = `
                <div class="card p-3 mb-3">
                    <h6>Growth <span class="text-muted small">(new accounts / month)</span></h6>
                    <div class="growth-bars">${growthBars}</div>
                    <div class="d-flex gap-3 mt-2 small text-muted">
                        <span><span style="display:inline-block;width:8px;height:8px;background:var(--teal);border-radius:2px;margin-right:4px;"></span>Students</span>
                        <span><span style="display:inline-block;width:8px;height:8px;background:var(--amber);border-radius:2px;margin-right:4px;"></span>Teachers/Parents</span>
                    </div>
                </div>
                <div class="card p-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h6 class="mb-0">Income by School</h6>
                        <span class="fw-bold">${data.overallCollectionPct !== null ? data.overallCollectionPct + '% collected' : '—'}</span>
                    </div>
                    ${incomeRows}
                </div>`;
        } catch (e) {
            box.innerHTML = '';
        }
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

    // ==========================================
    // ADMIN: PARENT ACCOUNTS
    // ==========================================
    async function addOrUpdateParent(btn) {
        const data = {
            id: document.getElementById('p-id').value.trim(),
            name: document.getElementById('p-name').value.trim(),
            password: document.getElementById('p-pass').value,
            linkedStudentIds: document.getElementById('p-students').value.split(',').map(s => s.trim()).filter(Boolean)
        };
        if (!data.id || !data.name || data.linkedStudentIds.length === 0) return alert("Parent ID, name, and at least one student ID are required.");

        btn.disabled = true;
        try {
            const res = await authFetch('/api/admin/parents/upsert', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
            });
            const result = await res.json();
            alert(result.message);
            if (result.success) {
                document.getElementById('p-name').value = '';
                document.getElementById('p-id').value = '';
                document.getElementById('p-pass').value = '';
                document.getElementById('p-students').value = '';
                loadParents();
            }
        } finally { btn.disabled = false; }
    }

    async function loadParents() {
        const container = document.getElementById('parents-list-container');
        if (!container) return;
        container.innerHTML = "Loading...";
        try {
            const res = await authFetch('/api/admin/parents');
            const parents = await res.json();
            if (parents.length === 0) { container.innerHTML = "No parent accounts yet."; return; }
            container.innerHTML = parents.map(p => `
                <div class="card p-2 mb-2 d-flex justify-content-between align-items-center flex-row">
                    <div>
                        <strong>${p.name}</strong> <span class="text-muted small">(${p.studentId})</span><br>
                        <small class="text-muted">Linked: ${(p.linkedStudentIds || []).join(', ')}</small>
                    </div>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteParent('${p.studentId}')">Delete</button>
                </div>
            `).join('');
        } catch (e) { container.innerHTML = "Error loading parents."; }
    }

    async function deleteParent(id) {
        if (!confirm("Delete this parent account?")) return;
        await authFetch(`/api/admin/parents/${id}`, { method: 'DELETE' });
        loadParents();
    }

    // ==========================================
    // PARENT: MY CHILDREN PANEL
    // ==========================================
    let parentChildren = [];
    let selectedChildId = null;

    async function loadParentChildren() {
        const selector = document.getElementById('parent-child-selector');
        const details = document.getElementById('parent-child-details');
        selector.innerHTML = "Loading...";
        details.innerHTML = "";
        try {
            const res = await authFetch('/api/parent/children');
            parentChildren = await res.json();
            if (parentChildren.length === 0) {
                selector.innerHTML = "";
                details.innerHTML = `<p class="text-muted">No child linked to this account yet — contact the school admin.</p>`;
                return;
            }
            if (parentChildren.length > 1) {
                selector.innerHTML = `
                    <select class="form-select" onchange="selectChild(this.value)">
                        ${parentChildren.map(c => `<option value="${c.studentId}">${c.name} (${c.classId || 'N/A'})</option>`).join('')}
                    </select>`;
            } else {
                selector.innerHTML = "";
            }
            selectChild(parentChildren[0].studentId);
        } catch (e) { selector.innerHTML = ""; details.innerHTML = "Error loading child data."; }

        loadParentFeedbackHistory();
    }

    function selectChild(studentId) {
        selectedChildId = studentId;
        const child = parentChildren.find(c => c.studentId === studentId);
        const details = document.getElementById('parent-child-details');
        if (!child) return;
        const remaining = (child.totalFees || 0) - (child.feesPaid || 0);
        const perf = child.performance || {};
        details.innerHTML = `
            <div class="card p-3 mb-3">
                <h5 class="fw-bold mb-1">${child.name}</h5>
                <p class="text-muted small mb-2">Class: ${child.classId || 'N/A'} &middot; ID: ${child.studentId}</p>
                <div class="d-flex justify-content-between mb-2">
                    <span>Fees Remaining:</span><strong>₹${remaining}</strong>
                </div>
                <div class="d-flex justify-content-between">
                    <span>Feedback / Notes:</span><span class="text-muted">${perf.feedback || 'N/A'}</span>
                </div>
            </div>`;
        loadChildAttendanceSummary(studentId, details);
    }

    async function loadChildAttendanceSummary(studentId, details) {
        try {
            const res = await authFetch(`/api/student/attendance/${studentId}`);
            const records = await res.json();
            const present = records.filter(r => r.status === 'Present').length;
            const total = records.length;
            const pct = total > 0 ? Math.round((present / total) * 100) : 0;
            details.innerHTML += `
                <div class="card p-3">
                    <h6>Attendance</h6>
                    <div class="progress" style="height: 20px;">
                        <div class="progress-bar" style="width:${pct}%;">${pct}%</div>
                    </div>
                    <small class="text-muted">${present} present out of ${total} recorded days</small>
                </div>`;
        } catch (e) {}
    }

    // ==========================================
    // FEEDBACK
    // ==========================================
    async function submitFeedback(btn) {
        const category = document.getElementById('fb-category').value;
        const message = document.getElementById('fb-message').value.trim();
        if (!message) return alert("Please write a message.");
        btn.disabled = true;
        try {
            const res = await authFetch('/api/feedback', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ studentId: selectedChildId, category, message })
            });
            const result = await res.json();
            alert(result.message);
            if (result.success) {
                document.getElementById('fb-message').value = '';
                loadParentFeedbackHistory();
            }
        } finally { btn.disabled = false; }
    }

    function feedbackStatusBadge(status) {
        const map = { open: 'bg-warning text-dark', in_review: 'bg-info text-dark', resolved: 'bg-success' };
        return `<span class="badge ${map[status] || 'bg-secondary'}">${(status || '').replace('_',' ')}</span>`;
    }

    async function loadParentFeedbackHistory() {
        const container = document.getElementById('parent-feedback-list');
        if (!container) return;
        container.innerHTML = "Loading...";
        try {
            const res = await authFetch('/api/feedback');
            const items = await res.json();
            if (items.length === 0) { container.innerHTML = "No feedback submitted yet."; return; }
            container.innerHTML = items.map(f => `
                <div class="card p-2 mb-2">
                    <div class="d-flex justify-content-between align-items-start">
                        <strong class="small">${f.category}</strong> ${feedbackStatusBadge(f.status)}
                    </div>
                    <p class="mb-1 small">${f.message}</p>
                    ${f.response ? `<p class="mb-0 small text-muted"><strong>School:</strong> ${f.response}</p>` : ''}
                    <small class="text-muted">${new Date(f.date).toLocaleDateString()}</small>
                </div>
            `).join('');
        } catch (e) { container.innerHTML = "Error loading feedback."; }
    }

    async function loadFeedbackInbox() {
        const container = document.getElementById('feedback-inbox-list');
        container.innerHTML = "Loading...";
        try {
            const res = await authFetch('/api/feedback');
            const items = await res.json();
            if (items.length === 0) { container.innerHTML = "No feedback received yet."; return; }
            container.innerHTML = items.map(f => `
                <div class="card p-3 mb-2">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <strong>${f.category}</strong> <span class="text-muted small">from ${f.fromName} (re: ${f.studentId})</span>
                        </div>
                        ${feedbackStatusBadge(f.status)}
                    </div>
                    <p class="mt-2 mb-2">${f.message}</p>
                    ${f.response ? `<p class="small text-muted mb-2"><strong>Your response:</strong> ${f.response}</p>` : ''}
                    <div class="row g-2">
                        <div class="col-8">
                            <input type="text" class="form-control form-control-sm" id="fb-resp-${f._id}" placeholder="Write a response (optional)">
                        </div>
                        <div class="col-4">
                            <select class="form-select form-select-sm" id="fb-status-${f._id}">
                                <option value="open" ${f.status === 'open' ? 'selected' : ''}>Open</option>
                                <option value="in_review" ${f.status === 'in_review' ? 'selected' : ''}>In Review</option>
                                <option value="resolved" ${f.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                            </select>
                        </div>
                    </div>
                    <button class="btn btn-sm btn-primary w-100 mt-2" onclick="updateFeedbackStatus('${f._id}')">Save</button>
                </div>
            `).join('');
        } catch (e) { container.innerHTML = "Error loading feedback."; }
    }

    async function updateFeedbackStatus(id) {
        const status = document.getElementById(`fb-status-${id}`).value;
        const response = document.getElementById(`fb-resp-${id}`).value;
        const res = await authFetch(`/api/feedback/${id}/status`, {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ status, response })
        });
        const result = await res.json();
        if (result.success) loadFeedbackInbox(); else alert(result.message || "Update failed.");
    }

    // ==========================================
    // CHAT (Phase 2C)
    // ==========================================
    function escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadChatBadge() {
        try {
            const res = await authFetch('/api/chat/threads');
            if (!res.ok) return;
            const threads = await res.json();
            const unread = threads.filter(t => t.unread).length;
            const badge = document.getElementById('chat-badge');
            if (badge) {
                badge.style.display = unread > 0 ? 'inline-block' : 'none';
                badge.innerText = unread > 9 ? '9+' : unread;
            }
        } catch (e) {}
    }

    async function loadChatHub() {
        closeChatThread(true);
        await loadChatContacts();
        await loadChatThreadList();
    }

    async function loadChatContacts() {
        const container = document.getElementById('chat-new-contacts');
        container.innerHTML = "Loading contacts...";
        try {
            const res = await authFetch('/api/chat/contacts');
            const data = await res.json();
            const user = JSON.parse(localStorage.getItem('currentUser'));
            let options = [];
            if (user.role === 'teacher') {
                options = [
                    ...(data.admins || []).map(a => ({ label: `Admin: ${a.name}`, otherPartyId: a.id })),
                    ...(data.parents || []).map(p => ({ label: `${p.name} — parent of ${p.studentName}`, otherPartyId: p.id, studentId: p.studentId }))
                ];
            } else if (user.role === 'parent') {
                options = (data.teachers || []).map(t => ({ label: `${t.name} — ${t.studentName}'s teacher`, otherPartyId: t.id, studentId: t.studentId }));
            } else if (user.role === 'admin') {
                options = [
                    ...(data.teachers || []).map(t => ({ label: `Teacher: ${t.name}`, otherPartyId: t.id })),
                    ...(data.owner ? [{ label: `Owner: ${data.owner.name}`, otherPartyId: data.owner.id }] : [])
                ];
            } else if (user.role === 'owner') {
                options = (data.admins || []).map(a => ({ label: `${a.name} (${a.schoolName})`, otherPartyId: a.id }));
            }

            if (options.length === 0) {
                container.innerHTML = `<p class="text-muted small">No contacts available to message yet.</p>`;
                window._chatContactOptions = [];
                return;
            }
            window._chatContactOptions = options;
            container.innerHTML = `
                <div class="card p-2 mb-2">
                    <label class="small mb-1">Start a new chat</label>
                    <select id="chat-new-contact-select" class="form-select form-select-sm mb-2">
                        ${options.map((o, i) => `<option value="${i}">${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                    <button class="btn btn-sm btn-primary w-100" onclick="startNewChat()">Start Chat</button>
                </div>`;
        } catch (e) {
            container.innerHTML = `<p class="text-muted small">Couldn't load contacts.</p>`;
        }
    }

    async function startNewChat() {
        const select = document.getElementById('chat-new-contact-select');
        const option = (window._chatContactOptions || [])[select ? select.value : -1];
        if (!option) return;
        try {
            const res = await authFetch('/api/chat/threads/start', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ otherPartyId: option.otherPartyId, studentId: option.studentId || null })
            });
            const result = await res.json();
            if (!result.success) return alert(result.message || "Couldn't start chat.");
            await loadChatThreadList();
            openChatThread(result.thread._id);
        } catch (e) { alert("Couldn't start chat."); }
    }

    async function loadChatThreadList() {
        const container = document.getElementById('chat-thread-list');
        container.innerHTML = "Loading...";
        try {
            const res = await authFetch('/api/chat/threads');
            const threads = await res.json();
            currentThreads = threads;
            if (threads.length === 0) { container.innerHTML = `<p class="text-muted small">No conversations yet.</p>`; return; }
            container.innerHTML = threads.map(t => `
                <div class="card p-2 mb-2" style="cursor:pointer;" onclick="openChatThread('${t._id}')">
                    <div class="d-flex justify-content-between align-items-start">
                        <span class="${t.unread ? 'fw-bold' : ''}">${escapeHtml(t.otherPartyName)}${t.studentName ? ` <span class="text-muted small">(re: ${escapeHtml(t.studentName)})</span>` : ''}</span>
                        ${t.unread ? '<span class="badge bg-danger">new</span>' : ''}
                    </div>
                    <div class="text-muted small">${t.lastMessage ? escapeHtml(t.lastMessage) : 'No messages yet'}</div>
                </div>
            `).join('');
        } catch (e) { container.innerHTML = "Error loading conversations."; }
    }

    async function openChatThread(id) {
        currentThreadId = id;
        const thread = currentThreads.find(t => t._id === id);
        document.getElementById('chat-new-contacts').style.display = 'none';
        document.getElementById('chat-thread-list').style.display = 'none';
        document.getElementById('chat-thread-view').style.display = 'block';
        document.getElementById('chat-thread-title').innerText = thread ? thread.otherPartyName : 'Chat';
        document.getElementById('chat-thread-sub').innerText = thread && thread.studentName ? `Regarding ${thread.studentName}` : '';
        await loadChatMessages();
        if (chatMessagePoll) clearInterval(chatMessagePoll);
        chatMessagePoll = setInterval(loadChatMessages, 8000);
    }

    function closeChatThread(skipReload) {
        currentThreadId = null;
        if (chatMessagePoll) clearInterval(chatMessagePoll);
        const view = document.getElementById('chat-thread-view');
        if (view) view.style.display = 'none';
        const contacts = document.getElementById('chat-new-contacts');
        if (contacts) contacts.style.display = 'block';
        const list = document.getElementById('chat-thread-list');
        if (list) list.style.display = 'block';
        if (!skipReload) { loadChatThreadList(); loadChatBadge(); }
    }

    async function loadChatMessages() {
        if (!currentThreadId) return;
        const user = JSON.parse(localStorage.getItem('currentUser'));
        const box = document.getElementById('chat-messages');
        try {
            const res = await authFetch(`/api/chat/threads/${currentThreadId}/messages`);
            const messages = await res.json();
            box.innerHTML = messages.map(m => `
                <div class="chat-bubble ${m.senderId === user.id ? 'chat-bubble-mine' : 'chat-bubble-theirs'}">
                    <div>${escapeHtml(m.message)}</div>
                    <div class="chat-bubble-time">${new Date(m.date).toLocaleString()}</div>
                </div>
            `).join('');
            box.scrollTop = box.scrollHeight;
        } catch (e) {}
    }

    async function sendChatMessage() {
        const input = document.getElementById('chat-input');
        const message = input.value.trim();
        if (!message || !currentThreadId) return;
        input.value = '';
        try {
            const res = await authFetch(`/api/chat/threads/${currentThreadId}/messages`, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ message })
            });
            const result = await res.json();
            if (!result.success) { alert(result.message || "Couldn't send message."); return; }
            loadChatMessages();
        } catch (e) { alert("Couldn't send message."); }
    }

    // ==========================================
    // OVERSIGHT (Phase 2C — read-only monitor views)
    // ==========================================
    async function loadOversightPanel() {
        closeOversightThread();
        const container = document.getElementById('oversight-thread-list');
        container.innerHTML = "Loading...";
        try {
            const res = await authFetch('/api/oversight/threads');
            const threads = await res.json();
            currentOversightThreads = threads;
            if (threads.length === 0) { container.innerHTML = `<p class="text-muted small">No conversations yet.</p>`; return; }
            container.innerHTML = threads.map(t => `
                <div class="card p-2 mb-2" style="cursor:pointer;" onclick="openOversightThread('${t._id}')">
                    <div class="d-flex justify-content-between align-items-start">
                        <span>${t.participants.map(p => escapeHtml(p.name)).join(' ↔ ')}</span>
                        <span class="badge bg-secondary">${t.type.replace('-', ' ↔ ')}</span>
                    </div>
                    ${t.studentName ? `<div class="text-muted small">Re: ${escapeHtml(t.studentName)}</div>` : ''}
                    ${t.schoolName ? `<div class="text-muted small">${escapeHtml(t.schoolName)}</div>` : ''}
                    <div class="text-muted small">${t.lastMessage ? escapeHtml(t.lastMessage) : 'No messages yet'}</div>
                </div>
            `).join('');
        } catch (e) { container.innerHTML = "Error loading conversations."; }
    }

    async function openOversightThread(id) {
        const thread = currentOversightThreads.find(t => t._id === id);
        document.getElementById('oversight-thread-list').style.display = 'none';
        document.getElementById('oversight-thread-view').style.display = 'block';
        document.getElementById('oversight-thread-title').innerText = thread ? thread.participants.map(p => p.name).join(' ↔ ') : 'Conversation';
        document.getElementById('oversight-thread-sub').innerText = thread && thread.studentName
            ? `Regarding ${thread.studentName}` : (thread && thread.schoolName ? thread.schoolName : '');
        try {
            const res = await authFetch(`/api/oversight/threads/${id}/messages`);
            const messages = await res.json();
            document.getElementById('oversight-messages').innerHTML = messages.map(m => `
                <div class="chat-bubble chat-bubble-theirs">
                    <div class="small text-muted">${escapeHtml(m.senderRole)}</div>
                    <div>${escapeHtml(m.message)}</div>
                    <div class="chat-bubble-time">${new Date(m.date).toLocaleString()}</div>
                </div>
            `).join('');
        } catch (e) {}
    }

    function closeOversightThread() {
        const view = document.getElementById('oversight-thread-view');
        if (view) view.style.display = 'none';
        const list = document.getElementById('oversight-thread-list');
        if (list) list.style.display = 'block';
    }

    // ==========================================
    // NOTIFICATIONS (polled every 30s, see activateApp)
    // ==========================================
    async function loadNotifications() {
        try {
            const res = await authFetch('/api/notifications');
            if (!res.ok) return;
            const items = await res.json();
            const unread = items.filter(n => !n.read).length;
            const badge = document.getElementById('notif-badge');
            if (badge) {
                badge.style.display = unread > 0 ? 'inline-block' : 'none';
                badge.innerText = unread > 9 ? '9+' : unread;
            }
            const list = document.getElementById('notif-list');
            if (list) {
                list.innerHTML = items.length === 0
                    ? `<p class="text-muted small text-center m-0">No notifications yet.</p>`
                    : items.map(n => `
                        <div class="p-2 border-bottom small ${n.read ? '' : 'fw-bold'}">
                            ${n.message}
                            <div class="text-muted" style="font-weight:normal;">${new Date(n.date).toLocaleString()}</div>
                        </div>
                    `).join('');
            }
        } catch (e) {}
    }

    function toggleNotificationPanel() {
        const panel = document.getElementById('notif-panel');
        const isOpen = panel.style.display === 'block';
        panel.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) markAllNotificationsRead();
    }

    async function markAllNotificationsRead() {
        try {
            await authFetch('/api/notifications/mark-read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({}) });
            const badge = document.getElementById('notif-badge');
            if (badge) badge.style.display = 'none';
        } catch (e) {}
    }
