import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { PopupApp } from "../../src/app/popup/PopupApp";
import "../../src/app/styles.css";
import "../../src/app/popup/popup.css";

const root = document.getElementById("app-root");

if (!root) {
  throw new Error("Nook popup root is missing");
}

createRoot(root).render(createElement(PopupApp));
