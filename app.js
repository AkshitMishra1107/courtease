// app.js
// CourtEase — FINAL SUBMISSION
// Features: Real PDF Reading (Via Gemini Vision), Real Firebase, Fixed Model Names

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

// --- FIXED IMPORTS (THESE WERE MISSING) ---
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer"); // <--- Added
const axios = require("axios");   // <--- Added
const admin = require("firebase-admin"); // <--- Added
const { GoogleGenerativeAI } = require("@google/generative-ai"); // <--- Added
// ------------------------------------------

const app = express();
const PORT = 3000;

// Middleware Setup: MUST BE IN THIS ORDER
app.use(cors()); // 1. CORS enabled FIRST
app.use(bodyParser.json({ limit: '50mb' })); // 2. JSON body parser SECOND
app.use(bodyParser.urlencoded({ extended: true })); // 3. URL-encoded parser THIRD
const upload = multer({ storage: multer.memoryStorage() }); // 4. Multer setup

// ==================================================================
// 1. CONFIGURATION
// ==================================================================

const CONFIG = {
    // Read keys from environment variables for deployment (SECURE)
    FIREBASE_WEB_API_KEY: process.env.FIREBASE_WEB_API_KEY, 
    INDIAN_KANOON_TOKEN: process.env.INDIAN_KANOON_TOKEN , 
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    
    // Kept for local fallback only:
    FIREBASE_KEY_PATH: "./serviceAccountKey.json"
};

// ==================================================================
// 2. INITIALIZATION
// ==================================================================

let db = null;
let IS_FIREBASE_LIVE = false;
let genAI = null;

// Firebase
try {
    const serviceAccountJsonString = process.env.FIREBASE_SERVICE_ACCOUNT;
    let serviceAccount = null;

    if (serviceAccountJsonString) {
        // Read key from Vercel Environment Variable (Secure)
        serviceAccount = JSON.parse(serviceAccountJsonString);
    } else if (require('fs').existsSync(CONFIG.FIREBASE_KEY_PATH)) {
        // Fallback for local development
        serviceAccount = require(CONFIG.FIREBASE_KEY_PATH);
    }
    
    if (serviceAccount) {
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        IS_FIREBASE_LIVE = true;
        console.log("🔥 Firebase Live");
    } else {
        console.log("⚠️ Mock Mode (Key Missing - No Env Var or Local File)");
    }
} catch (e) { console.log("⚠️ Init Error:", e.message); }

// Gemini
if (CONFIG.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    console.log("🤖 Gemini AI Ready");
}

const MOCK_DB = { users: [] };

// ==================================================================
// 3. BACKEND LOGIC
// ==================================================================

async function registerUser(name, email, password, role) {
    if (IS_FIREBASE_LIVE) {
        try {
            const userRecord = await admin.auth().createUser({ email, password, displayName: name });
            
            // 1. Save to Database
            await db.collection('users').doc(userRecord.uid).set({ 
                name, email, role, 
                createdAt: new Date().toISOString(),
                stats: { cases: 0, docs: 0 }
            });

            // 2. SEND WELCOME EMAIL (FIX ADDED HERE)
            await sendMail(
                email, 
                "Welcome to CourtEase", 
                `<h2>Welcome, ${name}!</h2>
                 <p>Your account has been successfully created as a <b>${role}</b>.</p>
                 <p>You can now log in to your dashboard.</p>`
            );

            return { success: true };
        } catch (e) { return { success: false, message: e.message }; }
    }
    MOCK_DB.users.push({ name, email, password, role });
    return { success: true, message: "Mock Registered" };
}

async function loginUser(email, password) {
    if (IS_FIREBASE_LIVE) {
        try {
            const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_WEB_API_KEY}`;
            const res = await axios.post(url, { email, password, returnSecureToken: true });
            const uid = res.data.localId;
            const doc = await db.collection('users').doc(uid).get();
            const userData = doc.exists ? doc.data() : { name: "User", role: "Litigant", stats: {cases:0, docs:0} };
            return { success: true, user: { id: uid, ...userData, email } };
        } catch (e) { return { success: false, message: e.response?.data?.error?.message || "Login Failed" }; }
    }
    const user = MOCK_DB.users.find(u => u.email === email && u.password === password);
    return user ? { success: true, user } : { success: false, message: "Invalid Credentials" };
}

async function updateUserProfile(uid, data) {
    if (IS_FIREBASE_LIVE) {
        try {
            await db.collection('users').doc(uid).update(data);
            if(data.name) await admin.auth().updateUser(uid, { displayName: data.name });
            return { success: true };
        } catch(e) { return { success: false, message: e.message }; }
    }
    return { success: true };
}

async function searchJudgments(query) {
    if (CONFIG.INDIAN_KANOON_TOKEN) {
        try {
            const res = await axios.post(
                'https://api.indiankanoon.org/search/?formInput=' + encodeURIComponent(query),
                {}, { headers: { 'Authorization': `Token ${CONFIG.INDIAN_KANOON_TOKEN}` } }
            );
            return res.data.docs.map(d => ({ 
                title: d.title, 
                court: d.docsource, 
                link: `https://indiankanoon.org/doc/${d.tid}/` 
            }));
        } catch(e) { console.log("API Error, using fallback"); }
    }
    return [
        { title: "Kesavananda Bharati v. State of Kerala", court: "Supreme Court", link: "#" },
        { title: "Vishaka v. State of Rajasthan", court: "Supreme Court", link: "#" }
    ];
}

// --- 🚀 FIXED AI FUNCTIONS ---

async function processDocument(buffer) {
  if (!CONFIG.GEMINI_API_KEY) return { summary: "AI Key Missing", facts: "", judgments: [], solutions: [] };

  const prompt = `
You are a Senior Indian Advocate. Read the provided PDF content (a case document) and meticulously extract the core facts and key legal points. Output a JSON object ONLY (no markdown):

{
  "summary": "<plain English summary of the case>",
  "facts": "<Concise, numbered list or paragraph of the core facts of the case, suitable for SWOT analysis>",
  "judgments": [ {"title":"...","court":"...","relevance":"..."} ],
  "solutions": ["step 1", "step 2"]
}
`;

  const base64Data = buffer.toString("base64");
  const defaultErrorResponse = { summary: "Error analyzing document", facts: "", judgments: [], solutions: [] };

  try {
    if (genAI && typeof genAI.getGenerativeModel === "function") {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const sdkPayload = [
        { inlineData: { data: base64Data, mimeType: "application/pdf" } },
        { text: prompt } 
      ];

      const result = await model.generateContent(sdkPayload);
      const text = (result?.response?.text && result.response.text()) || (typeof result === 'string' ? result : null);
      if (text) {
        const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
        try { return JSON.parse(cleaned); } catch (e) { 
          return { ...defaultErrorResponse, summary: "AI returned non-JSON output (SDK). Raw: " + cleaned };
        }
      }
    }
  } catch (sdkErr) {
    console.warn("SDK path failed:", sdkErr?.message || sdkErr);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    const body = {
      contents: [
        {
          parts: [
            { text: "(PDF content follows as base64 inlineData; the assistant should process this PDF)" },
            { inlineData: { data: base64Data, mime_type: "application/pdf" } }
          ],
          role: "user"
        },
        {
          parts: [{ text: prompt }],
          role: "user"
        }
      ]
    };

    const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const cand = r.data?.candidates?.[0] || r.data?.result || r.data;
    const text = cand?.content?.[0]?.text || cand?.content?.text || cand?.output?.[0]?.content?.text || cand?.output?.text || JSON.stringify(r.data);
    const cleaned = String(text).replace(/```json/g, "").replace(/```/g, "").trim();
    try { return JSON.parse(cleaned); } catch (e) {
      return { ...defaultErrorResponse, summary: "AI returned non-JSON (REST). Raw: " + cleaned };
    }
  } catch (restErr) {
    console.error("REST fallback failed:", restErr?.response?.data || restErr?.message || restErr);
    return { ...defaultErrorResponse, summary: "Error analyzing document: " + (restErr?.response?.data?.error?.message || restErr?.message || "unknown") };
  }
}

async function chatAI(msg) {
  if (!CONFIG.GEMINI_API_KEY) return "AI Key Missing";
  const prompt = `You are an Indian Lawyer. Answer briefly and plainly to the user question: "${msg}"`;

  try {
    if (genAI && typeof genAI.getGenerativeModel === "function") {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const res = await model.generateContent(prompt);
      return (res?.response?.text && res.response.text()) || String(res);
    }
  } catch (e) { console.warn("chatAI SDK failed:", e?.message || e); }

  try {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const cand = r.data?.candidates?.[0] || r.data;
    return cand?.content?.[0]?.text || cand?.content?.text || JSON.stringify(r.data);
  } catch (err) {
    return "AI Error: " + (err?.response?.data?.error?.message || err?.message || "unknown");
  }
}

async function analyzeCase(text) {
  if (!CONFIG.GEMINI_API_KEY) return { summary: "AI Error - key missing", facts: "", strengths: [], weaknesses: [] };
  const prompt = `Analyze this case under Indian Law. First, re-state the core facts concisely, then perform the SWOT. Return JSON ONLY:
{ "summary": "Overall analysis summary...", "facts": "The core facts provided: ${text}", "strengths": ["..."], "weaknesses": ["..."] }
Case Facts: ${text}`;
  const defaultErrorResponse = { summary: "Analysis Failed", facts: text, strengths: [], weaknesses: [] };
  
  try {
    if (genAI && typeof genAI.getGenerativeModel === "function") {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const res = await model.generateContent(prompt);
      const txt = (res?.response?.text && res.response.text()) || String(res);
      const cleaned = txt.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleaned);
    }
  } catch (sdkErr) { console.warn("analyzeCase SDK failed:", sdkErr?.message || sdkErr); }

  try {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
    const cand = r.data?.candidates?.[0] || r.data;
    const txt = cand?.content?.[0]?.text || cand?.content?.text || JSON.stringify(r.data);
    const cleaned = String(txt).replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (restErr) {
    return { ...defaultErrorResponse, summary: "Analysis Failed: " + (restErr?.response?.data?.error?.message || restErr?.message || "unknown") };
  }
}

// ==================================================================
// 4. UI TEMPLATE
// ==================================================================

function render(title, content, user = null, isDashboard = false) {
    const publicNavbar = `
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/features">Features</a>
            <a href="/pricing">Pricing</a>
            <a href="/about">About Us</a>
            <a href="/contact">Contact</a>
            <div class="divider"></div>
            <a href="/login" class="link-login">Login</a>
            <a href="/register" class="btn-primary">Get Started</a>
        </div>
    `;

    let sidebarLinks = `
        <div class="sb-header">My Workspace</div>
        <a href="/dashboard"><i class="ri-dashboard-line"></i> Dashboard</a>
        <a href="/track"><i class="ri-search-eye-line"></i> Track Status</a>
        
        <div class="sb-header">AI Tools</div>
        <a href="/upload"><i class="ri-upload-cloud-2-line"></i> Upload Docs</a>
        <a href="/search"><i class="ri-government-line"></i> Judgment Search</a>
        <a href="/analyzer"><i class="ri-brain-line"></i> AI Strategy</a>
        <a href="/chat"><i class="ri-robot-2-line"></i> Legal Assistant</a>

        <div class="sb-header">Settings</div>
        <a href="/edit-profile"><i class="ri-user-settings-line"></i> Edit Profile</a>
    `;

    if (user && user.role === 'Admin') {
        sidebarLinks += `
            <div class="sb-header">System Admin</div>
            <a href="/admin/users"><i class="ri-group-line"></i> Manage Users</a>
        `;
    }

    const dashboardSidebar = `
        <div class="sidebar">
            <div class="user-profile">
                <div class="avatar">${user?.name ? user.name[0] : 'U'}</div>
                <div>
                    <strong>${user?.name || 'User'}</strong>
                    <small>${user?.role || 'Guest'}</small>
                </div>
            </div>
            <div class="menu">
                ${sidebarLinks}
            </div>
            <div class="menu-bottom">
                <a href="#" onclick="logout()" style="color:#ef4444;"><i class="ri-logout-box-line"></i> Logout</a>
            </div>
        </div>
    `;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | CourtEase AI</title>
    <link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #0F172A; 
            --accent: #D97706;  
            --bg: #F8FAFC;
            --text: #334155;
            --white: #FFFFFF;
            --border: #E2E8F0;
        }
        * { margin:0; padding:0; box-sizing:border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg); color: var(--text); overflow-x: hidden; }
        
        nav { height: 80px; background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; padding: 0 5%; position: sticky; top:0; z-index:1000; }
        .logo { font-size: 1.6rem; font-weight: 800; color: var(--primary); text-decoration: none; display:flex; align-items:center; gap:8px; }
        .nav-links { display: flex; align-items: center; gap: 25px; }
        .nav-links a { text-decoration: none; color: var(--text); font-weight: 600; font-size: 0.95rem; transition: 0.2s; position:relative; }
        .nav-links a:hover { color: var(--accent); }
        .divider { width:1px; height:20px; background:#CBD5E1; }

        .btn-primary { background: var(--primary); color: white !important; padding: 12px 24px; border-radius: 8px; transition: 0.2s; box-shadow: 0 4px 10px rgba(15,23,42,0.2); cursor:pointer; border:none; font-weight:600; text-decoration:none; display:inline-block; }
        .btn-primary:hover { background: var(--accent); transform: translateY(-2px); }
        .btn-outline { border: 2px solid var(--primary); color: var(--primary); padding: 10px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; background: transparent; transition: 0.2s; display:inline-block; }
        .btn-outline:hover { background: var(--primary); color: white; }

        .dashboard-container { display: flex; min-height: calc(100vh - 80px); }
        .sidebar { width: 280px; background: var(--white); border-right: 1px solid var(--border); padding: 25px; display: flex; flex-direction: column; position:fixed; top:80px; bottom:0; overflow-y:auto; }
        .user-profile { display: flex; gap: 12px; align-items: center; padding-bottom: 25px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
        .avatar { width: 45px; height: 45px; background: var(--accent); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.2rem; }
        .menu a { display: flex; align-items: center; gap: 12px; padding: 12px; color: var(--text); text-decoration: none; border-radius: 8px; font-weight: 500; transition:0.2s; margin-bottom: 5px; }
        .menu a:hover { background: #F1F5F9; color: var(--primary); }
        .menu-bottom { margin-top: auto; }
        .sb-header { font-size:0.75rem; text-transform:uppercase; color:#94A3B8; margin:20px 0 5px 10px; font-weight:700; }
        .main-content { flex: 1; padding: 40px; margin-left:280px; }

        .card { background: var(--white); padding: 30px; border-radius: 16px; border: 1px solid var(--border); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02); transition:0.3s; margin-bottom:20px; }
        .card:hover { transform: translateY(-5px); box-shadow: 0 10px 20px -3px rgba(0,0,0,0.05); border-color: var(--accent); }
        .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
        
        input, textarea, select { width: 100%; padding: 14px; border: 1px solid #CBD5E1; border-radius: 8px; margin-bottom: 20px; font-family: inherit; font-size: 1rem; }
        .feature-icon { width: 60px; height: 60px; background: #FFF7ED; color: var(--accent); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin-bottom: 20px; }

        .typing-container { min-height: 50px; font-size: 3.5rem; font-weight: 800; color: var(--primary); margin-bottom: 10px; line-height: 1.1; }
        .cursor { display: inline-block; width: 4px; height: 1em; background-color: var(--accent); animation: blink 1s infinite; vertical-align: bottom; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        .animate-up { animation: fadeUp 0.8s ease-out; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }

        footer { background: var(--primary); color: white; padding: 60px 5%; margin-top: 80px; }
        .footer-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 40px; }
        .footer-col h4 { margin-bottom: 20px; color: var(--accent); }
        .footer-col a { display: block; color: #94A3B8; text-decoration: none; margin-bottom: 10px; }
        .footer-col a:hover { color: white; }

        @media (max-width: 768px) {
            .nav-links { display: none; }
            .grid-3, .grid-2, .footer-grid { grid-template-columns: 1fr; }
            .sidebar { display:none; }
            .main-content { margin-left:0; }
        }
    </style>
</head>
<body>
    <nav>
        <a href="/" class="logo"><i class="ri-government-fill" style="color:var(--accent)"></i> CourtEase</a>
        ${isDashboard ? '' : publicNavbar}
    </nav>

    ${isDashboard ? `
        <div class="dashboard-container">
            ${dashboardSidebar}
            <div class="main-content animate-up">${content}</div>
        </div>
    ` : `
        <div class="animate-up">${content}</div>
        <footer>
            <div class="footer-grid">
                <div class="footer-col">
                    <h3>CourtEase</h3>
                    <p style="color:#94A3B8; margin-top:15px; line-height:1.6;">AI-powered legal intelligence platform for India. <br>HQ: Thapar Institute, Patiala.</p>
                </div>
                <div class="footer-col">
                    <h4>Platform</h4>
                    <a href="/features">Features</a>
                    <a href="/pricing">Pricing</a>
                    <a href="/login">Login</a>
                </div>
                <div class="footer-col">
                    <h4>Company</h4>
                    <a href="/about">About Us</a>
                    <a href="/contact">Contact</a>
                </div>
                <div class="footer-col">
                    <h4>Legal</h4>
                    <a href="#">Privacy</a>
                    <a href="#">Terms</a>
                </div>
            </div>
            <div style="border-top:1px solid #1E293B; margin-top:40px; padding-top:20px; text-align:center; color:#64748B;">
                &copy; 2025 CourtEase Legal Technologies Pvt Ltd. All rights reserved.
            </div>
        </footer>
    `}

    <script>
        function logout() { localStorage.removeItem('ce_user'); window.location.href='/login'; }
        async function apiCall(url, body) {
            const res = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            return await res.json();
        }
    </script>
</body>
</html>`;
}

// ==================================================================
// 5. API ROUTES
// ==================================================================

app.post('/api/register', async (req, res) => res.json(await registerUser(req.body.name, req.body.email, req.body.password, req.body.role)));
app.post('/api/login', async (req, res) => res.json(await loginUser(req.body.email, req.body.password)));
app.post('/api/update-profile', async (req, res) => res.json(await updateUserProfile(req.body.uid, req.body.data)));
app.post('/api/search', async (req, res) => res.json({ results: await searchJudgments(req.body.query) }));
app.post('/api/analyze', async (req, res) => res.json({ success: true, data: await analyzeCase(req.body.text) }));
app.post('/api/chat', async (req, res) => res.json({ reply: await chatAI(req.body.msg) }));

app.post('/api/upload', upload.single('document'), async (req, res) => {
    if (!req.file) return res.json({ success: false, message: "No file" });
    const result = await processDocument(req.file.buffer);
    if(typeof result === 'string' && result.startsWith("Error")) {
        return res.json({ success: false, message: result });
    }
    res.json({ success: true, data: result });
});

// ==================================================================
// 6. PUBLIC PAGES
// ==================================================================

app.get('/', (req, res) => res.send(render('Home', `
    <div style="text-align:center; padding: 100px 20px; max-width: 900px; margin: 0 auto;">
        <div style="font-size:3.5rem; font-weight:800; color:#0F172A; margin-bottom:10px;">
            Justice Delivered
        </div>
        <div class="typing-container">
            <span id="typewriter"></span><span class="cursor"></span>
        </div>
        
        <p style="font-size: 1.3rem; color: #64748B; margin: 30px auto 50px; line-height: 1.6; max-width:700px;">
            A unified operating system for Litigants, Lawyers, and the Judiciary. 
            Bridge the gap with AI-driven research and instant legal clarity.
        </p>
        
        <div style="display: flex; justify-content: center; gap: 20px;">
            <a href="/register" class="btn-primary" style="padding: 16px 36px; font-size: 1.1rem; text-decoration:none;">Start Free Trial</a>
            <a href="/about" class="btn-outline" style="padding: 16px 36px; font-size: 1.1rem;">Learn More</a>
        </div>
    </div>

    <script>
        const words = ["with AI Precision.", "Instantly.", "Affordably.", "for Everyone."];
        let i = 0, j = 0, isDeleting = false, speed = 100;
        function type() {
            const currentWord = words[i];
            const text = currentWord.substring(0, j);
            document.getElementById("typewriter").innerHTML = text;
            if (isDeleting) j--; else j++;
            if (!isDeleting && j === currentWord.length) { isDeleting = true; speed = 2000; } 
            else if (isDeleting && j === 0) { isDeleting = false; i = (i + 1) % words.length; speed = 500; } 
            else speed = isDeleting ? 50 : 100;
            setTimeout(type, speed);
        }
        document.addEventListener("DOMContentLoaded", type);
    </script>

    <div style="background:#F1F5F9; padding: 60px 0;">
        <div style="max-width:1100px; margin:0 auto; display:grid; grid-template-columns: repeat(4, 1fr); gap:20px; text-align:center;">
            <div><h2 style="font-size:3rem; color:#0F172A;">4.5Cr+</h2><p>Pending Cases</p></div>
            <div><h2 style="font-size:3rem; color:#D97706;">10x</h2><p>Faster Research</p></div>
            <div><h2 style="font-size:3rem; color:#0F172A;">24/7</h2><p>AI Availability</p></div>
            <div><h2 style="font-size:3rem; color:#D97706;">Zero</h2><p>Bias</p></div>
        </div>
    </div>
`)));

app.get('/about', (req, res) => res.send(render('About Us', `
    <div style="max-width:1000px; margin:60px auto; padding:0 20px;">
        <h1 style="font-size:3rem; margin-bottom:30px; text-align:center; color:#0F172A;">The Crisis We Are Solving</h1>
        <div class="grid-2">
            <div>
                <h3 style="color:#D97706;">The Problem</h3>
                <p style="font-size:1.1rem; line-height:1.8; color:#334155; margin-bottom:20px;">
                    The Indian Judiciary faces a backlog of over <strong>4.5 Crore cases</strong>. For a common citizen, legal processes are:
                </p>
                <ul style="list-style:none; line-height:2;">
                    <li><strong>Expensive:</strong> High legal fees prevent access to justice.</li>
                    <li><strong>Complex:</strong> Legal language is difficult to understand.</li>
                    <li><strong>Slow:</strong> Cases drag on for decades.</li>
                </ul>
            </div>
            <div>
                <h3 style="color:#0F172A;">Our Solution</h3>
                <p style="font-size:1.1rem; line-height:1.8; color:#334155; margin-bottom:20px;">
                    CourtEase leverages Generative AI to bridge this gap. We provide:
                </p>
                <ul style="list-style:none; line-height:2;">
                    <li> <strong>Instant Simplification:</strong> Translating law into plain English/Hindi.</li>
                    <li><strong>Affordable Access:</strong> AI bots handling routine queries at zero cost.</li>
                    <li><strong>Data-Driven Strategy:</strong> Helping lawyers win faster.</li>
                </ul>
            </div>
        </div>
    </div>
`)));

app.get('/features', (req, res) => res.send(render('Features', `
    <div style="text-align:center; padding:60px 20px;">
        <h1 style="font-size:3rem; margin-bottom:20px;">Detailed Features</h1>
        <p style="color:#64748B; font-size:1.2rem;">Tools designed for the Indian Legal Ecosystem.</p>
    </div>
    <div class="grid-3" style="max-width:1200px; margin:0 auto;">
        <div class="card"><h3><i class="ri-search-eye-line" style="color:#D97706"></i> Judgment Search</h3><p>Access the entire Indian Kanoon database. Filter by Court, Year, and Judge.</p></div>
        <div class="card"><h3><i class="ri-translate-2" style="color:#D97706"></i> Vernacular AI</h3><p>Translate judgments from English to Hindi, Punjabi, Tamil, and more instantly.</p></div>
        <div class="card"><h3><i class="ri-brain-line" style="color:#D97706"></i> Strategy Builder</h3><p>AI generates a SWOT analysis identifying winning arguments.</p></div>
        <div class="card"><h3><i class="ri-notification-3-line" style="color:#D97706"></i> Smart Alerts</h3><p>Automated SMS/Email tracking for Case Hearings.</p></div>
        <div class="card"><h3><i class="ri-draft-line" style="color:#D97706"></i> Auto-Drafting</h3><p>Generate legal notices, rent agreements, and affidavits in seconds.</p></div>
        <div class="card"><h3><i class="ri-shield-keyhole-line" style="color:#D97706"></i> Secure Vault</h3><p>AES-256 encrypted cloud storage for sensitive client documents.</p></div>
    </div>
`)));

app.get('/contact', (req, res) => res.send(render('Contact', `
    <div class="card" style="max-width:700px; margin:60px auto; padding:40px;">
        <h2 style="text-align:center; margin-bottom:30px;">Contact HQ</h2>
        <div class="grid-2">
            <div><h4><i class="ri-map-pin-line"></i> Address</h4><p>Thapar Institute of Engineering & Technology,<br>Patiala, Punjab - 147004</p></div>
            <div><h4><i class="ri-mail-line"></i> Support</h4><p>helpdesk@courtease.in<br>+91 98765-43210</p></div>
        </div>
    </div>
`)));

app.get('/login', (req, res) => res.send(render('Login', `
    <div class="card" style="max-width:400px; margin:60px auto; text-align:center;">
        <h2 style="color:#0F172A;">Login</h2>
        <form onsubmit="handleLogin(event)">
            <input id="email" type="email" placeholder="Email Address" required>
            <input id="pass" type="password" placeholder="Password" required>
            <button class="btn-primary" style="width:100%;">Access Portal</button>
        </form>
    </div>
    <script>
        async function handleLogin(e) {
            e.preventDefault();
            const res = await apiCall('/api/login', { email: document.getElementById('email').value, password: document.getElementById('pass').value });
            if(res.success) { localStorage.setItem('ce_user', JSON.stringify(res.user)); window.location.href='/dashboard'; }
            else alert(res.message);
        }
    </script>
`)));

app.get('/register', (req, res) => res.send(render('Register', `
    <div class="card" style="max-width:500px; margin:60px auto; text-align:center;">
        <h2 style="color:#0F172A;">Create Account</h2>
        <form onsubmit="handleReg(event)">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <input id="name" placeholder="Full Name" required>
                <select id="role"><option>Litigant</option><option>Lawyer</option><option>Admin</option></select>
            </div>
            <input id="email" type="email" placeholder="Email Address" required>
            <input id="pass" type="password" placeholder="Password" required>
            <button class="btn-primary" style="width:100%;">Sign Up</button>
        </form>
    </div>
    <script>
        async function handleReg(e) {
            e.preventDefault();
            const res = await apiCall('/api/register', { name: document.getElementById('name').value, email: document.getElementById('email').value, password: document.getElementById('pass').value, role: document.getElementById('role').value });
            if(res.success) { alert("Registration Successful!"); window.location.href='/login'; }
            else alert(res.message);
        }
    </script>
`)));

// ==================================================================
// 7. PRIVATE DASHBOARD
// ==================================================================

const authCheck = `<script>if(!localStorage.getItem('ce_user')) window.location.href='/login'; const currentUser = JSON.parse(localStorage.getItem('ce_user'));</script>`;

app.get('/dashboard', (req, res) => res.send(render('Dashboard', `
    ${authCheck}
    <h1 style="margin-bottom:10px;">Dashboard</h1>
    <p style="color:#64748B; margin-bottom:30px;">Overview of your legal activities.</p>
    <div class="grid-3">
        <div class="card" style="text-align:center;">
            <h2 id="st_cases">...</h2><p>Active Cases</p>
        </div>
        <div class="card" style="text-align:center;">
            <h2 id="st_docs">...</h2><p>Documents</p>
        </div>
        <div class="card" style="text-align:center;">
            <h2 style="color:green">Active</h2><p>Account Status</p>
        </div>
    </div>
    <script>
        const stats = currentUser.stats || { cases: 0, docs: 0 };
        document.getElementById('st_cases').innerText = stats.cases;
        document.getElementById('st_docs').innerText = stats.docs;
    </script>
`, {name:"User", role:"Member"}, true)));

app.get('/edit-profile', (req, res) => res.send(render('Edit Profile', `
    ${authCheck}
    <h1>Edit Profile</h1>
    <div class="card" style="max-width:600px;">
        <label>Full Name</label>
        <input id="nm" value="${'${currentUser.name}'}">
        <label>Role</label>
        <select id="rl">
            <option value="Litigant">Litigant</option>
            <option value="Lawyer">Lawyer</option>
        </select>
        <button class="btn-primary" onclick="save()">Save Changes</button>
    </div>
    <script>
        document.getElementById('rl').value = currentUser.role;
        async function save() {
            const name = document.getElementById('nm').value;
            const role = document.getElementById('rl').value;
            const res = await apiCall('/api/update-profile', { uid: currentUser.id, data: { name, role } });
            if(res.success) {
                currentUser.name = name;
                currentUser.role = role;
                localStorage.setItem('ce_user', JSON.stringify(currentUser));
                alert("Profile Updated!");
                location.reload();
            } else alert(res.message);
        }
    </script>
`, {name:"User", role:"Member"}, true)));

app.get('/search', (req, res) => res.send(render('Search', `
    ${authCheck}
    <h1>Judgment Search</h1>
    <div class="card">
        <p>Search Indian Kanoon Database</p>
        <div style="display:flex; gap:10px;">
            <input id="q" placeholder="Enter keywords (e.g. Dowry, Property)">
            <button class="btn-primary" style="width:auto;" onclick="search()">Search</button>
        </div>
    </div>
    <div id="results"></div>
    <script>
        async function search() {
            document.getElementById('results').innerHTML = "<p>Searching...</p>";
            const res = await apiCall('/api/search', { query: document.getElementById('q').value });
            const html = res.results.map(r => \`<div class="card"><h4><a href="\${r.link}" target="_blank">\${r.title}</a></h4><small>\${r.court}</small></div>\`).join('');
            document.getElementById('results').innerHTML = html || "<p>No results.</p>";
        }
    </script>
`, {name:"User", role:"Member"}, true)));

app.get('/upload', (req, res) => res.send(render('Upload & Research', `
    ${authCheck}
    <h1>Upload Document</h1>
    <div class="card">
        <div style="border:2px dashed #ccc; padding:40px; text-align:center; border-radius:10px; cursor:pointer;" onclick="document.getElementById('fileIn').click()">
            <i class="ri-file-upload-line" style="font-size:3rem; color:#D97706;"></i>
            <p>Click to Upload PDF</p>
            <input type="file" id="fileIn" style="display:none" accept="application/pdf" onchange="uploadFile()">
        </div>
        <div id="loader" style="display:none; text-align:center; margin-top:20px;">AI is analyzing...</div>
    </div>
    
    <div id="result" style="display:none;">
        <div class="card" style="background:#F8FAFC;">
            <h3>AI Summary</h3>
            <p id="sum" style="line-height:1.6;"></p>
        </div>
        <div class="card" style="background:#FFF7ED; border-left: 5px solid var(--accent);">
            <h3>Case Facts</h3>
            <pre id="facts" style="white-space: pre-wrap; margin-top:10px; color:#52525B; font-size: 0.95rem;"></pre>
        </div>
        <div class="grid-2">
            <div class="card">
                <h3>Similar Judgments</h3>
                <div id="judg"></div>
            </div>
            <div class="card">
                <h3>Legal Advice</h3>
                <ul id="sol" style="padding-left: 20px;"></ul>
            </div>
        </div>
        <div style="text-align:right;">
             <button class="btn-primary" onclick="window.location.href='/analyzer?caseId=' + currentCaseId">Analyze Strategy</button>
        </div>
    </div>

    <script>
        let currentCaseId = null;

        async function uploadFile() {
            const file = document.getElementById('fileIn').files[0];
            if(!file) return;
            document.getElementById('loader').style.display = 'block';
            document.getElementById('result').style.display = 'none';

            const formData = new FormData();
            formData.append('document', file);
            const res = await fetch('/api/upload', { method: 'POST', body: formData }).then(r => r.json());
            
            document.getElementById('loader').style.display = 'none';
            if(res.success) {
                const d = res.data;
                const saveRes = await apiCall('/api/save-case', {
                    userId: currentUser.id,
                    email: currentUser.email,
                    data: d
                });

                if(saveRes.success) {
                    currentCaseId = saveRes.caseId;
                    document.getElementById('result').style.display = 'block';
                    document.getElementById('sum').innerText = d.summary;
                    document.getElementById('facts').innerText = d.facts || "Facts not available.";
                    document.getElementById('judg').innerHTML = d.judgments.map(j => \`<div style="margin-bottom:10px; border-bottom:1px solid #eee;"><strong>\${j.title}</strong><br><small>\${j.court}</small><br>\${j.relevance}</div>\`).join('');
                    document.getElementById('sol').innerHTML = d.solutions.map(s => \`<li>\${s}</li>\`).join('');
                } else {
                    alert("Analysis Complete but saving failed: " + saveRes.message);
                }
            } else { alert("Upload failed: " + res.message); }
        }
    </script>
`, {name:"User"}, true)));

app.get('/track', (req, res) => res.send(render('Case Tracking', `
    ${authCheck}
    <h1>Case Tracking & Status</h1>
    <p style="color:#64748B; margin-bottom:30px;">
        ${'${currentUser.role}' === 'Lawyer' ? 'Manage and update your ongoing cases. Notifications are sent automatically to clients on status change.' : 'View the current status and details of your cases.'}
    </p>

    <div id="caseList" class="grid-2" style="gap:20px;">
        <p>Loading cases...</p>
    </div>

    <div id="caseDetail" class="card" style="display:none; max-width: 800px; margin-top: 30px;">
        <h2 id="caseDetailTitle">Case ID: <span id="caseIdDisplay"></span></h2>
        <div style="font-size: 1.1rem; margin-bottom: 20px;">
            Status: <strong id="statusDisplay"></strong> | Next Hearing: <strong id="hearingDateDisplay"></strong>
        </div>
        
        <h3>Case Summary</h3>
        <p id="summaryDetail" style="margin-bottom: 20px;"></p>

        <h3>Facts of the Case</h3>
        <pre id="factsDetail" style="white-space: pre-wrap; background: #F8FAFC; padding: 10px; border-radius: 6px;"></pre>

        <div id="lawyerControls" style="margin-top: 30px; border-top: 1px solid var(--border); padding-top: 20px; display: none;">
            <h4>Update Status & Hearing (Lawyer Only)</h4>
            <div style="display:flex; gap:10px;">
                <select id="newStatus" style="flex:1;">
                    <option value="Submitted">Submitted</option>
                    <option value="Filed">Filed</option>
                    <option value="Hearing Scheduled">Hearing Scheduled</option>
                    <option value="On Hold">On Hold</option>
                    <option value="Closed">Closed</option>
                </select>
                <input id="newHearingDate" type="date" style="flex:1;">
            </div>
            <button class="btn-primary" style="width:100%;" onclick="updateCase()">Update Case</button>
        </div>
    </div>

    <script>
        let casesData = [];
        async function loadCases() {
            let api = currentUser.role === 'Lawyer' ? '/api/all-cases' : '/api/get-cases';
            let body = currentUser.role === 'Litigant' ? { userId: currentUser.id } : {};
            const res = await apiCall(api, body);
            const caseListDiv = document.getElementById('caseList');
            caseListDiv.innerHTML = '';
            if(res.success && res.cases.length > 0) {
                casesData = res.cases;
                res.cases.forEach(c => {
                    const client = currentUser.role === 'Lawyer' ? 'Client: ' + c.userId : '';
                    caseListDiv.innerHTML += \`
                        <div class="card" style="cursor:pointer;" onclick="viewCase('\${c.caseId}')">
                            <h4 style="color:var(--primary);">Case ID: \${c.caseId}</h4>
                            <p>\${client}</p>
                            <p>Status: <strong>\${c.status}</strong></p>
                            <small>Next: \${c.hearingDate || 'N/A'}</small>
                        </div>
                    \`;
                });
            } else {
                caseListDiv.innerHTML = '<p>No cases found.</p>';
            }
        }
        function viewCase(caseId) {
            const caseDetail = casesData.find(c => c.caseId === caseId);
            if (!caseDetail) return;
            document.getElementById('caseList').style.display = 'none';
            document.getElementById('caseDetail').style.display = 'block';
            document.getElementById('caseIdDisplay').innerText = caseId;
            document.getElementById('caseDetailTitle').innerText = 'Case ID: ' + caseId;
            document.getElementById('statusDisplay').innerText = caseDetail.status;
            document.getElementById('hearingDateDisplay').innerText = caseDetail.hearingDate || 'TBD';
            document.getElementById('summaryDetail').innerText = caseDetail.summary;
            document.getElementById('factsDetail').innerText = caseDetail.facts || "Facts not available.";
            if (currentUser.role === 'Lawyer') {
                document.getElementById('lawyerControls').style.display = 'block';
                document.getElementById('newStatus').value = caseDetail.status;
                document.getElementById('newHearingDate').value = caseDetail.hearingDate || '';
            } else {
                document.getElementById('lawyerControls').style.display = 'none';
            }
        }
        async function updateCase() {
            const caseId = document.getElementById('caseIdDisplay').innerText;
            const status = document.getElementById('newStatus').value;
            const hearingDate = document.getElementById('newHearingDate').value;
            await apiCall('/api/cases/update-status', { caseId, status });
            await apiCall('/api/cases/update-hearing', { caseId, hearingDate });
            alert('Case updated successfully! Client will be notified.');
            await loadCases();
            viewCase(caseId);
        }
        loadCases(); 
    </script>
`, {name:"User", role:"Member"}, true)));

app.get('/chat', (req, res) => res.send(render('Chat', `${authCheck}<h1>AI Legal Assistant</h1><div class="card"><input id="msg" placeholder="Ask Query"><button class="btn-primary" onclick="chat()">Send</button><div id="res" style="margin-top:10px"></div></div><script>async function chat(){const m=document.getElementById('msg').value; const r=await apiCall('/api/chat',{msg:m}); document.getElementById('res').innerText=r.reply;}</script>`, {name:"User"}, true)));

app.get('/analyzer', (req, res) => res.send(render('Analyzer', `
    ${authCheck}
    <h1>Strategy Analyzer (SWOT)</h1>
    <p style="color:#64748B; margin-bottom:30px;">Generate a strategic analysis based on case facts. You can paste facts or select a saved case.</p>
    
    <div class="card">
        <h3>Input Case Facts</h3>
        <select id="caseSelector" onchange="loadCaseFacts()">
            <option value="">-- Select a Saved Case --</option>
        </select>
        <textarea id="txt" placeholder="Or paste the case facts/description here..." rows="8"></textarea>
        <button class="btn-primary" onclick="an()">Analyze Strategy</button>
    </div>

    <div id="out" class="card" style="display:none;">
        <h3>Analysis Result</h3>
        <p id="analysisSummary" style="margin-bottom: 20px;"></p>
        <div class="grid-2">
            <div>
                <h4>Strengths</h4>
                <ul id="strengthsList" style="list-style-type: disc; padding-left: 20px;"></ul>
            </div>
            <div>
                <h4>Weaknesses</h4>
                <ul id="weaknessesList" style="list-style-type: disc; padding-left: 20px;"></ul>
            </div>
        </div>
    </div>

    <script>
        let allCases = [];
        const urlParams = new URLSearchParams(window.location.search);
        const preselectCaseId = urlParams.get('caseId');
        async function fetchCasesForSelector() {
            const api = currentUser.role === 'Lawyer' ? '/api/all-cases' : '/api/get-cases';
            const body = currentUser.role === 'Litigant' ? { userId: currentUser.id } : {};
            const res = await apiCall(api, body);
            const selector = document.getElementById('caseSelector');
            selector.innerHTML = '<option value="">-- Select a Saved Case --</option>';
            if (res.success && res.cases.length > 0) {
                allCases = res.cases;
                res.cases.forEach(c => {
                    const option = document.createElement('option');
                    option.value = c.caseId;
                    option.textContent = 'Case ' + c.caseId;
                    selector.appendChild(option);
                });
                if (preselectCaseId) {
                    selector.value = preselectCaseId;
                    loadCaseFacts();
                }
            }
        }
        function loadCaseFacts() {
            const caseId = document.getElementById('caseSelector').value;
            const caseData = allCases.find(c => c.caseId === caseId);
            document.getElementById('txt').value = caseData ? caseData.facts : '';
        }
        async function an(){
            const facts = document.getElementById('txt').value;
            if (facts.trim() === "") { alert("Please enter case facts or select a case."); return; }
            document.getElementById('out').style.display = 'block';
            document.getElementById('analysisSummary').innerHTML = '<strong>Thinking...</strong>';
            document.getElementById('strengthsList').innerHTML = '';
            document.getElementById('weaknessesList').innerHTML = '';
            const res = await apiCall('/api/analyze', { text: facts });
            const data = res.data;
            document.getElementById('analysisSummary').innerText = data.summary;
            document.getElementById('strengthsList').innerHTML = data.strengths.map(s => \`<li>\${s}</li>\`).join('');
            document.getElementById('weaknessesList').innerHTML = data.weaknesses.map(w => \`<li>\${w}</li>\`).join('');
        }
        fetchCasesForSelector();
    </script>
`, {name:"User"}, true)));

// ==================================================================
// 8. CASE MANAGEMENT
// ==================================================================

// ==================================================================
// 8. CASE MANAGEMENT
// ==================================================================

const nodemailer = require("nodemailer");

// FIX: Read credentials from Environment Variables
const mailer = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER, // Reads from Vercel
        pass: process.env.EMAIL_PASS  // Reads from Vercel
    }
});

async function sendMail(to, subject, msg) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log("⚠️ Email skipped: Missing EMAIL_USER or EMAIL_PASS in env vars");
        return;
    }
    try {
        await mailer.sendMail({
            from: `"CourtEase Team" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html: msg
        });
        console.log("✅ Email sent to:", to);
    } catch (e) {
        console.log("❌ Email failed:", e.message);
    }
}

async function saveCaseToDB(userId, caseData) {
    if (!IS_FIREBASE_LIVE) return "MOCK-CASE-" + Date.now();
    const caseId = "CASE-" + Date.now();
    await db.collection("cases").doc(caseId).set({
        caseId,
        userId,
        summary: caseData.summary,
        facts: caseData.facts, 
        judgments: caseData.judgments,
        solutions: caseData.solutions,
        status: "Submitted",
        notes: [],
        hearingDate: null,
        createdAt: new Date().toISOString()
    });
    return caseId;
}

app.post("/api/save-case", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });
    const { userId, email, data } = req.body;
    const caseId = await saveCaseToDB(userId, data);
    sendMail(
        email,
        "Case Uploaded Successfully",
        `<h3>Your case has been uploaded to CourtEase</h3>
         <p>Case ID: <b>${caseId}</b></p>
         <p>Summary: ${data.summary}</p>`
    );
    res.json({ success: true, caseId });
});

app.post("/api/get-cases", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, cases: [] });
    const { userId } = req.body;
    const snap = await db.collection("cases").where("userId", "==", userId).get();
    res.json({
        success: true,
        cases: snap.docs.map(d => d.data())
    });
});

app.post("/api/all-cases", async (req, res) => { 
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, cases: [] });
    const snap = await db.collection("cases").get();
    res.json({
        success: true,
        cases: snap.docs.map(d => d.data())
    });
});

app.post("/api/cases/add-note", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });
    const { caseId, note } = req.body;
    const ref = db.collection("cases").doc(caseId);
    await ref.update({
        notes: admin.firestore.FieldValue.arrayUnion({
            text: note,
            time: new Date().toISOString()
        })
    });
    res.json({ success: true });
});

app.post("/api/cases/update-hearing", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });
    const { caseId, hearingDate } = req.body;
    const ref = db.collection("cases").doc(caseId);
    await ref.update({ hearingDate });
    const caseDoc = await ref.get();
    const userId = caseDoc.data()?.userId;
    const userDoc = await db.collection('users').doc(userId).get();
    const clientEmail = userDoc.data()?.email;
    if(clientEmail) {
        sendMail(clientEmail, 
                 "Case Update: New Hearing Date", 
                 `<p>The next hearing for your case (<b>${caseId}</b>) has been scheduled for <b>${hearingDate}</b>.</p>`);
    }
    res.json({ success: true });
});

app.post("/api/cases/update-status", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });
    const { caseId, status } = req.body;
    const ref = db.collection("cases").doc(caseId);
    await ref.update({ status });
    const caseDoc = await ref.get();
    const userId = caseDoc.data()?.userId;
    const userDoc = await db.collection('users').doc(userId).get();
    const clientEmail = userDoc.data()?.email;
    if(clientEmail) {
        sendMail(clientEmail, 
                 "Case Update: Status Changed", 
                 `<p>The status for your case (<b>${caseId}</b>) has been updated to <b>${status}</b>.</p>`);
    }
    res.json({ success: true });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`CourtEase running on http://localhost:${PORT}`));
}

module.exports = app;
