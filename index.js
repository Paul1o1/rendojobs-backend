const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { createHmac } = require("crypto");
const jwt = require("jsonwebtoken");

const app = express();

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
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: "Content-Type, Authorization",
  optionsSuccessStatus: 200, // For legacy browser support
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // Enable pre-flight for all routes

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
        console.log("User found in database. Normalizing user object.");
        user = {
          ...existingUser,
          user_metadata: existingUser.raw_user_meta_data || {},
        };
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

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  console.log("Authenticating token for:", req.path);
  const authHeader = req.headers["authorization"];
  console.log("Auth Header:", authHeader);
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) {
    console.error("Auth FAIL: No token provided.");
    return res.status(401).json({ success: false, error: "No token provided" });
  }

  try {
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        console.error("Auth FAIL: JWT verification callback error.", err);
        return res
          .status(403)
          .json({ success: false, error: "Token is not valid" });
      }
      console.log("Auth SUCCESS: Token decoded.", decoded);
      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error(
      "Auth FAIL: JWT verification threw a synchronous error.",
      error
    );
    return res.status(403).json({ success: false, error: "Malformed token" });
  }
};

// Protected Route to get user data
app.get("/api/user-profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Supabase fetch user error:", error);
      throw new Error("User not found");
    }

    // Normalize the user object to match frontend expectations
    const normalizedUser = {
      id: user.id,
      email: user.email,
      ...user.raw_user_meta_data, // Spread the metadata
    };

    res.json({ success: true, user: normalizedUser });
  } catch (error) {
    console.error("Error in /api/user-profile:", error);
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

// Add a ping endpoint for frontend-backend connectivity testing
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "pong from backend" });
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
