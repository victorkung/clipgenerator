import React from "react";
import { createRoot } from "react-dom/client";

// Local UI fonts (design system)
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";

import App from "./App.jsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layouts.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
