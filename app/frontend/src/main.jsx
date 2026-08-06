import React from "react";
import { createRoot } from "react-dom/client";

// Desk fonts (self-hosted)
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

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
