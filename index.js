const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { createHmac, timingSafeEqual } = require("crypto");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 5000; // Use port from environment or default to 5000

// Helper function to validate Telegram data
function validateTelegramData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculatedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    // For debugging, it can be useful to see why validation failed
    console.error("Hash validation failed.");
    console.error("Received hash:", hash);
    console.error("Calculated hash:", calculatedHash);
    return null;
  }

  const userJson = params.get("user");
  if (!userJson) return null;

  try {
    return JSON.parse(userJson);
  } catch (e) {
    return null;
  }
}

// Configure Multer for file uploads (in-memory storage for now)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Middleware to parse JSON bodies
app.use(express.json());

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// SECRETS - These must be set in your Render environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Allow all origins for debugging purposes.
// We should restrict this to the Vercel URL in production.
app.use(cors());

app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

// Endpoint for Telegram Login
app.post("/api/telegram-login", async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res
        .status(400)
        .json({ success: false, error: "Missing initData" });
    }

    if (!TELEGRAM_BOT_TOKEN || !JWT_SECRET) {
      console.error(
        "Missing TELEGRAM_BOT_TOKEN or JWT_SECRET in environment variables."
      );
      return res
        .status(500)
        .json({ success: false, error: "Server configuration error." });
    }

    const userData = validateTelegramData(initData, TELEGRAM_BOT_TOKEN);

    if (!userData) {
      return res
        .status(403)
        .json({ success: false, error: "Invalid Telegram data" });
    }

    const { id: telegram_id, first_name, last_name } = userData;

    // Check if user exists
    const { data: existingUser, error: fetchError } = await supabase
      .from("jobseekers")
      .select("*")
      .eq("telegram_id", telegram_id.toString())
      .limit(1);

    if (fetchError) throw fetchError;

    let user = existingUser.length > 0 ? existingUser[0] : null;

    // If user doesn't exist, create them
    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from("jobseekers")
        .insert({
          telegram_id: telegram_id.toString(),
          first_name: first_name || "",
          last_name: last_name || "",
          // Add other default fields if necessary
        })
        .select()
        .single();

      if (insertError) throw insertError;
      user = newUser;
    }

    // User is validated, create a JWT
    const token = jwt.sign(
      {
        id: user.id,
        telegram_id: user.telegram_id,
        name: `${user.first_name} ${user.last_name}`.trim(),
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error("Telegram login error:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Endpoint for job seeker registration with CV upload
app.post("/api/jobseekers/register", upload.single("cv"), async (req, res) => {
  try {
    const {
      telegramId,
      phoneNumber,
      email,
      firstName,
      lastName,
      dateOfBirth,
      careerQuestions,
    } = req.body;
    const cvFile = req.file; // The uploaded CV file
    let cvUrl = null;

    // Parse careerQuestions if it comes as a string
    const parsedCareerQuestions =
      typeof careerQuestions === "string"
        ? JSON.parse(careerQuestions)
        : careerQuestions;

    // Upload CV to Supabase Storage if provided
    if (cvFile) {
      const fileName = `${telegramId}_${Date.now()}_${cvFile.originalname}`;
      const { data, error: uploadError } = await supabase.storage
        .from("cvs") // Your Supabase Storage bucket name
        .upload(fileName, cvFile.buffer, { contentType: cvFile.mimetype });

      if (uploadError) {
        throw uploadError;
      }

      // Get public URL of the uploaded file
      const { data: publicUrlData } = supabase.storage
        .from("cvs")
        .getPublicUrl(fileName);

      if (publicUrlData) {
        cvUrl = publicUrlData.publicUrl;
      }
    }

    // Check if job seeker already exists by telegramId or email
    const { data: existingJobSeeker, error: fetchError } = await supabase
      .from("jobseekers")
      .select("id")
      .or(`telegram_id.eq.${telegramId},email.eq.${email}`);

    if (fetchError) {
      throw fetchError;
    }

    if (existingJobSeeker && existingJobSeeker.length > 0) {
      return res.status(409).json({
        message: "Job seeker with this Telegram ID or email already exists.",
      });
    }

    // Insert new job seeker
    const { data, error: insertError } = await supabase
      .from("jobseekers")
      .insert([
        {
          telegram_id: telegramId,
          phone_number: phoneNumber,
          email: email,
          first_name: firstName,
          last_name: lastName,
          date_of_birth: dateOfBirth,
          cv_url: cvUrl,
          career_questions: parsedCareerQuestions,
        },
      ])
      .select();

    if (insertError) {
      throw insertError;
    }

    res.status(201).json({
      message: "Job seeker registered successfully!",
      jobSeeker: data[0],
    });
  } catch (error) {
    console.error("Error during job seeker registration:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
