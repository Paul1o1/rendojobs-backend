const express = require("express");
const app = express();
const port = 5000; // You can choose any port

app.get("/", (req, res) => {
  res.send("Hello from the backend!");
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
