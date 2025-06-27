const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");

const app = express();
const port = process.env.PORT || 5000; // Use port from environment or default to 5000

// Configure Multer for file uploads (in-memory storage for now)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Middleware to parse JSON bodies
app.use(express.json());

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const corsOptions = {
  origin: "https://rendojobs-frontend.vercel.app", // Your Vercel frontend URL
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

app.get("/", (req, res) => {
  res.send("Hello from the backend!");
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
