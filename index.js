const express = require("express");
const cors = require("cors");
const app = express();
const port = 5000; // You can choose any port

const corsOptions = {
  origin: "https://rendojobs-frontend.vercel.app", // Your Vercel frontend URL
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
