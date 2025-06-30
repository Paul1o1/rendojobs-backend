const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { createHmac, timingSafeEqual } = require("crypto");
const jwt = require("jsonwebtoken");

const app = express();

// Middleware to normalize URL and remove double slashes
app.use((req, res, next) => {
  if (req.url.includes("//")) {
    req.url = req.url.replace(/\/+/g, "/");
  }
  next();
});

// VERBOSE REQUEST LOGGER - Logs every incoming request
app.use((req, res, next) => {
  console.log(`--> [${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("  Origin:", req.headers.origin);
  next();
});

const port = process.env.PORT || 5000;

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
    console.error("Hash validation failed.");
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

// Configure Multer and JSON middleware
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.use(express.json());

// Initialize Supabase with the admin service role key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Secrets from environment
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Configure CORS to allow requests from your frontend
const corsOptions = {
  origin: "https://rendojobs-frontend.vercel.app",
  optionsSuccessStatus: 200, // For legacy browser support
};
app.use(cors(corsOptions));

// Root endpoint
app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

// Telegram Login Endpoint
app.post("/api/telegram-login", async (req, res) => {
  console.log("Entered /api/telegram-login handler.");
  try {
    console.log("Request body:", JSON.stringify(req.body, null, 2));
    const { initData } = req.body;

    if (!initData) {
      console.error("Validation FAIL: Missing initData in request body.");
      return res
        .status(400)
        .json({ success: false, error: "Missing initData" });
    }
    console.log("initData received successfully. Validating...");

    const userData = validateTelegramData(initData, TELEGRAM_BOT_TOKEN);
    if (!userData) {
      console.error("Validation FAIL: Invalid Telegram data (hash mismatch).");
      return res
        .status(403)
        .json({ success: false, error: "Invalid Telegram data" });
    }
    console.log("Validation successful. User data:", userData);

    const { id: telegram_id, first_name, last_name } = userData;
    let user;

    try {
      console.log(
        `Attempting to find or create user with telegram_id: ${telegram_id}`
      );

      let { data: existingUser } = await supabase
        .from("users") // Use the standard 'users' table
        .select("*")
        .eq("raw_user_meta_data->>telegram_id", telegram_id.toString()) // Check inside the metadata
        .single();

      if (existingUser) {
        console.log("User found in database.");
        user = existingUser;
      } else {
        console.log(
          "User not found. Attempting to create new user in 'users' table."
        );
        const { data: newUser, error: insertError } =
          await supabase.auth.admin.createUser({
            email: `${telegram_id}@telegram.fake`, // Create a fake email
            email_confirm: true,
            user_metadata: {
              first_name: first_name,
              last_name: last_name,
              telegram_id: telegram_id.toString(),
            },
          });

        if (insertError) {
          console.error(
            "CRITICAL: Supabase auth user creation failed.",
            insertError
          );
          throw new Error("Failed to create new auth user.");
        }

        console.log("New auth user created successfully.");
        user = newUser.user; // The user object is nested
      }
    } catch (dbError) {
      console.error("CRITICAL: A database error occurred.", dbError);
      return res
        .status(500)
        .json({ success: false, error: "Database operation failed." });
    }

    console.log("User processing complete. Generating token.");
    const token = jwt.sign(
      {
        id: user.id,
        telegram_id: user.user_metadata.telegram_id,
        name: `${user.user_metadata.first_name} ${user.user_metadata.last_name}`.trim(),
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error("Full Telegram login error object:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Job Seeker Registration Endpoint
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

// Protected route to get user data
app.get("/api/protected", (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization header is missing or invalid.",
      });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: "Token is missing." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res
          .status(403)
          .json({ success: false, error: "Token is not valid." });
      }
      res.json({ success: true, user });
    });
  } catch (error) {
    console.error("Protected route error:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
