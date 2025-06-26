const express = require("express");
const cors = require("cors");
const app = express();
const port = 5000; // You can choose any port

app.use(cors()); // Enable CORS for all routes

app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
