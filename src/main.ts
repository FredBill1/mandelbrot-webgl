import "./styles.css";
import { startApp } from "./app";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing app root");

startApp(root).catch((error) => {
  root.innerHTML = `<pre class="fatal">${error instanceof Error ? error.message : String(error)}</pre>`;
});
