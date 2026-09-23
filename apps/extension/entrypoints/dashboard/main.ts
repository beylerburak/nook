import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { DashboardApp } from "../../src/app/dashboard/DashboardApp";
import "../../src/app/styles.css";

const root = document.getElementById("app-root");

if (!root) {
  throw new Error("Nook dashboard root is missing");
}

createRoot(root).render(createElement(DashboardApp));
