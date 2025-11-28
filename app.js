// app.js
// CourtEase — FINAL SUBMISSION
// Features: Real PDF Reading (Via Gemini Vision), Real Firebase, Fixed Model Names
// app.js (Add this at the very first line)
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
// app.js (Near the top)
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const admin = require("firebase-admin");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require("cors"); // <--- FIX 1: ADDED REQUIRED PACKAGE
const nodemailer = require("nodemailer"); // <--- ADDED REQUIRED PACKAGE (Needed for sendMail function)

const app = express();
const PORT = 3000;

// Middleware Setup: MUST BE IN THIS ORDER
app.use(cors()); // <--- FIX 2: ADDED CORS MIDDLEWARE TO PREVENT CROSS-ORIGIN ERRORS
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
    NODEMAILER_PASS: process.env.NODEMAILER_PASS, // Assuming this key exists in .env or Vercel secrets
    
    // Kept for local fallback only:
    FIREBASE_KEY_PATH: "./serviceAccountKey.json"
};


let IS_FIREBASE_LIVE = false;
let db;
let auth;

try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : require(CONFIG.FIREBASE_KEY_PATH);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    auth = admin.auth();
    IS_FIREBASE_LIVE = true;
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Firebase Admin SDK initialization failed. Running in Mock Mode.", error.message);
}

// Nodemailer transport setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'courtease.notification@gmail.com',
        pass: CONFIG.NODEMAILER_PASS
    }
});

function sendMail(to, subject, htmlContent) {
    if (!CONFIG.NODEMAILER_PASS) {
        console.log(`Email Mock: To: ${to}, Subject: ${subject}`);
        return;
    }
    const mailOptions = {
        from: 'courtease.notification@gmail.com',
        to: to,
        subject: subject,
        html: htmlContent
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Nodemailer Error:', error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}


// Middleware to protect routes (optional, but good practice)
async function verifyToken(req, res, next) {
    // Mock Mode bypass
    if (!IS_FIREBASE_LIVE) {
        req.user = { uid: "mock-user-id" };
        return next();
    }
    
    // Get the ID token from the Authorization header
    const idToken = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;

    if (!idToken) {
        return res.status(401).json({ success: false, message: 'Authorization required.' });
    }

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken; // Attaches the decoded user to the request
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
}

// ==================================================================
// 2. USER REGISTRATION
// ==================================================================

app.post("/api/register", async (req, res) => {
    
    // ------------------------------------------------------------------
    // CRITICAL FIX 3: ADDED SAFETY CHECK TO PREVENT CRASH ("undefined is not valid JSON")
    if (!req.body || !req.body.email || !req.body.password) {
        return res.status(400).json({ 
            success: false, 
            message: "Error: Registration data missing. Client must use 'Content-Type: application/json' and JSON.stringify()."
        });
    }
    // ------------------------------------------------------------------

    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "User mock-registered (Firebase not live)" });

    const { email, password } = req.body;

    try {
        // 1. Create user in Firebase Authentication
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            emailVerified: false,
            disabled: false
        });

        const userId = userRecord.uid;

        // 2. Create user document in Firestore (for profile/metadata)
        await db.collection('users').doc(userId).set({
            email: email,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Add any other default fields here
        });

        // 3. Send welcome email (asynchronous)
        sendMail(email, 
                 "Welcome to CourtEase!", 
                 `<p>Hello,</p><p>Thank you for registering! Your account has been successfully created.</p>`);


        res.json({ 
            success: true, 
            userId: userId, 
            message: "User registered successfully. Welcome email sent." 
        });

    } catch (error) {
        let errorMessage = "Registration failed.";
        // Handle Firebase specific errors
        if (error.code === 'auth/email-already-in-use') {
            errorMessage = "This email is already in use.";
        }
        console.error("Firebase Registration Error:", error.message);
        res.status(400).json({ success: false, message: errorMessage });
    }
});

// ==================================================================
// 3. USER LOGIN & TOKEN GENERATION
// ==================================================================

app.post("/api/login", async (req, res) => {
    // This is typically handled client-side with Firebase SDK, but here's a server-side token generation mockup
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, token: "mock-jwt-token", message: "Mock Login Success" });

    // Since we can't securely verify password server-side without an expensive lookup, 
    // a real app uses client SDK for login and sends the resultant token here.
    // For this demonstration, we assume successful authentication.
    const { email } = req.body;

    try {
        const userRecord = await auth.getUserByEmail(email);
        // This is not a real login, but simulates success after client-side login
        const customToken = await auth.createCustomToken(userRecord.uid);

        res.json({ success: true, token: customToken, userId: userRecord.uid, message: "Login successful (Token generated)" });
    } catch (error) {
        console.error("Firebase Login Error:", error.message);
        res.status(401).json({ success: false, message: "Invalid credentials or user not found." });
    }
});


// ==================================================================
// 4. AI FEATURE: DOCUMENT ANALYSIS (PDF / Image)
// ==================================================================

// The 'upload.single('file')' middleware handles the file buffer
app.post("/api/ai/analyze-document", upload.single('file'), verifyToken, async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ summary: "Mock Analysis: The document is an important legal paper that needs immediate review.", caseId: "CASE-MOCK-001" });

    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
    }

    if (!CONFIG.GEMINI_API_KEY) {
        return res.status(500).json({ success: false, message: "GEMINI_API_KEY not configured." });
    }

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const base64Data = fileBuffer.toString('base64');
    
    // For large files, use the Gemini API (model gemini-2.5-flash)
    const gemini = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);

    try {
        const prompt = `Analyze this legal document. Extract the following information and return it in a structured JSON format: 
        1. "summary": A brief, one-paragraph summary of the document's content and legal issue.
        2. "parties": List of key parties involved (e.g., Plaintiff, Defendant).
        3. "next_steps": Recommended immediate action for the client.
        4. "keywords": A list of 3-5 keywords.
        5. "potential_case_id": Generate a unique case ID based on the document's content (e.g., COURT-YYYYMMDD-XYZ).
        `;

        const response = await gemini.getGenerativeModel('gemini-2.5-flash').generateContent({
            contents: [
                {
                    inlineData: {
                        data: base64Data,
                        mimeType: mimeType
                    }
                },
                prompt
            ],
            config: {
                responseMimeType: "application/json",
            }
        });

        // The response text is already a JSON string from the model
        const jsonResponse = JSON.parse(response.text);

        // Optional: Save case document data to Firestore here
        const caseId = jsonResponse.potential_case_id;

        await db.collection("cases").doc(caseId).set({
            userId: req.user.uid,
            summary: jsonResponse.summary,
            parties: jsonResponse.parties,
            keywords: jsonResponse.keywords,
            status: "New Case - Review Required", // Default status
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Storing document reference would require saving the file to storage (e.g., Firebase Storage)
        });

        res.json({ 
            success: true,
            summary: jsonResponse.summary, 
            caseId: caseId,
            details: jsonResponse 
        });

    } catch (error) {
        console.error("Gemini AI or Firestore Error:", error);
        res.status(500).json({ success: false, message: "AI analysis failed due to server error or invalid document." });
    }
});


// ==================================================================
// 5. AI FEATURE: LEGAL RESEARCH (Indian Kanoon API)
// ==================================================================

app.post("/api/ai/legal-research", verifyToken, async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ results: [{ title: "Mock Judgement 1", url: "#" }, { title: "Mock Judgement 2", url: "#" }] });

    const { query } = req.body;

    if (!CONFIG.INDIAN_KANOON_TOKEN) {
        return res.status(500).json({ success: false, message: "INDIAN_KANOON_TOKEN not configured." });
    }
    
    try {
        const searchUrl = `https://api.indiankanoon.org/search/?formInput=${encodeURIComponent(query)}`;
        
        const response = await axios.get(searchUrl, {
            headers: {
                // IMPORTANT: Indian Kanoon API uses 'Authorization' header for token
                'Authorization': `Token ${CONFIG.INDIAN_KANOON_TOKEN}`,
                'Accept': 'application/json'
            }
        });

        // The API returns a list of results under the 'results' key
        const results = response.data.results.map(r => ({
            title: r.title,
            url: r.url
        }));

        res.json({ success: true, results: results });

    } catch (error) {
        console.error("Indian Kanoon API Error:", error.message);
        let errorMessage = "Legal research failed. Check if Indian Kanoon Token is valid.";
        if (error.response?.status === 401) {
             errorMessage = "Unauthorized: Invalid Indian Kanoon Token.";
        }
        res.status(500).json({ success: false, message: errorMessage });
    }
});


// ==================================================================
// ENDPOINTS FOR CASE MANAGEMENT (Requires Token)
// ==================================================================

// 5. GET ALL CASES FOR A USER
app.get("/api/cases", verifyToken, async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ cases: [{ id: "MOCK-001", summary: "Mock Case Summary" }] });
    
    try {
        const snapshot = await db.collection("cases")
                                .where("userId", "==", req.user.uid)
                                .orderBy("createdAt", "desc")
                                .get();
        
        const cases = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({ success: true, cases: cases });

    } catch (error) {
        console.error("Firestore Error:", error);
        res.status(500).json({ success: false, message: "Failed to retrieve cases." });
    }
});

// 6. UPDATE NEXT HEARING DATE (Sends Client Notification)
app.post("/api/cases/update-hearing", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });

    const { caseId, hearingDate } = req.body;

    const ref = db.collection("cases").doc(caseId);
    await ref.update({ hearingDate });

    // Simplified Notification: Find user's email
    const caseDoc = await ref.get();
    const userId = caseDoc.data()?.userId;
    const userDoc = await db.collection('users').doc(userId).get();
    const clientEmail = userDoc.data()?.email;

    if(clientEmail) {
        sendMail(clientEmail, 
                 "Case Update: Next Hearing Date", 
                 `<p>The next hearing for your case (<b>${caseId}</b>) has been scheduled for <b>${hearingDate}</b>.</p>`);
    }

    res.json({ success: true });
});

// 6. UPDATE CASE STATUS (Sends Client Notification)
app.post("/api/cases/update-status", async (req, res) => {
    if (!IS_FIREBASE_LIVE) return res.json({ success: true, message: "Mock Mode" });

    const { caseId, status } = req.body;

    const ref = db.collection("cases").doc(caseId);
    await ref.update({ status });

    // Simplified Notification: Find user's email
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

// ==================================================================
// END NEW FEATURES
// ==================================================================

// Vercel only uses the exported app, and manages the listener internally.
// Only listen locally if the file is run directly.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

// Export the app for Vercel
module.exports = app;
