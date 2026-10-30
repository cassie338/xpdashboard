import { chromium } from "playwright-core";

const appUrl = "http://127.0.0.1:3100";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
const forbiddenRequests = [];
const httpErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("request", (request) => {
  const hostname = new URL(request.url()).hostname;
  if (hostname.endsWith("supabase.co")) forbiddenRequests.push(request.url());
});
page.on("response", (response) => {
  if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function enterParentView() {
  await page.getByRole("button", { name: "Parent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "What is your birthyear?" });
  await dialog.getByLabel("Birth year").fill("1987");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Weekly plan" }).waitFor();
}

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "First time? Create the family account" }).click();
  const email = `browser-${crypto.randomUUID()}@example.invalid`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(`Local-only-${crypto.randomUUID()}-A1!`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("heading", { name: "XP Dashboard" }).waitFor({ timeout: 15000 });

  await page.getByText("Set up this week: A parent can include or exclude the tasks below").waitFor();
  assert(await page.getByText("Unassigned", { exact: true }).count() === 0, "First-week setup showed Unassigned instead of dates.");
  assert(/^[A-Z]{3} \d{1,2}$/i.test(await page.locator(".day-card").first().locator("p").first().innerText()), "First-week setup date was missing.");

  await enterParentView();
  const setupTaskCount = await page.getByRole("button", { name: /^Exclude / }).count();
  assert(setupTaskCount === 5, `Expected 5 included setup tasks, got ${setupTaskCount}.`);
  await page.getByRole("button", { name: "Exclude Write one great paragraph" }).click();
  await page.getByRole("button", { name: "Include Write one great paragraph" }).click();
  await page.getByRole("button", { name: "Exclude Write one great paragraph" }).waitFor();

  await page.getByRole("button", { name: "Start first weekly plan" }).click();
  await page.getByText("Current", { exact: true }).waitFor();
  const learnerSelect = page.locator("header select.week-picker").first();
  const firstLearnerValue = await learnerSelect.inputValue();
  const firstPlanOptions = await page.getByLabel("View week").locator("option").allTextContents();
  assert(firstPlanOptions.length === 2, `Expected current plus legacy options, got ${firstPlanOptions.length}.`);
  assert(firstPlanOptions.some((option) => option.includes("Current")), "Current week option was missing.");
  assert(firstPlanOptions.some((option) => option === "Legacy / Unassigned"), "Legacy option was missing.");

  const wednesdayPlan = page.locator(".parent-day-plan").filter({ has: page.getByRole("heading", { name: "Wednesday", exact: true }) });
  const wednesdayReward = wednesdayPlan.getByLabel("Daily reward");
  await wednesdayReward.fill("Choose tonight's family game");
  await wednesdayReward.press("Tab");
  await wednesdayPlan.locator(".support-select").selectOption("with_parent");

  await page.getByRole("button", { name: "Learner", exact: true }).click();
  const firstTask = page.locator(".day-card").filter({ has: page.getByRole("heading", { name: "Wednesday", exact: true }) }).locator(".task-button").first();
  await firstTask.click();
  await page.getByRole("heading", { name: "Write one great paragraph", exact: true }).waitFor();
  await page.getByText("Do with a parent", { exact: true }).waitFor();
  await page.getByText("Choose tonight's family game").last().waitFor();
  await page.getByRole("button", { name: "Start with my parent" }).click();
  await page.getByRole("button", { name: "I need help" }).click();
  await page.getByText("Your help request is saved for your parent.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "I finished it" }).click();
  await firstTask.getByText("Completed · Tap to undo").waitFor();
  const completedWeeklyText = await page.locator(".tracker").filter({ hasText: "Weekly" }).innerText();
  assert(/25\s*\/\s*115 XP/.test(completedWeeklyText), `Unexpected completion total: ${completedWeeklyText}`);

  const celebration = page.locator(".celebration");
  await celebration.waitFor({ state: "visible" });
  await celebration.getByRole("button", { name: "Awesome!" }).click();

  await firstTask.click();
  await firstTask.getByText("With a parent").waitFor();
  const undoneWeeklyText = await page.locator(".tracker").filter({ hasText: "Weekly" }).innerText();
  assert(/0\s*\/\s*115 XP/.test(undoneWeeklyText), `Unexpected undo total: ${undoneWeeklyText}`);

  const mondayTask = page.locator(".day-card").filter({ has: page.getByRole("heading", { name: "Monday", exact: true }) }).locator(".task-button").first();
  await mondayTask.getByRole("button", { name: "Complete Math practice" }).click();
  await mondayTask.getByText("Completed · Tap to undo").waitFor();
  await celebration.waitFor({ state: "visible" });
  await celebration.getByRole("button", { name: "Awesome!" }).click();
  await mondayTask.getByRole("button", { name: "Undo Math practice" }).click();
  await mondayTask.getByText("Math", { exact: true }).waitFor();

  await enterParentView();
  const helpPanel = page.locator(".paper-panel").filter({ has: page.getByRole("heading", { name: "Help requests" }) });
  await helpPanel.getByText("Write one great paragraph", { exact: true }).waitFor();
  await helpPanel.getByRole("button", { name: "Resolved" }).click();
  await helpPanel.waitFor({ state: "detached" });
  const removeWednesdayButton = page.getByRole("button", { name: "Remove Write one great paragraph" });
  await removeWednesdayButton.click();
  await removeWednesdayButton.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Start next week", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("header select.week-picker")[1]?.querySelectorAll("option").length === 3);
  const historyOptions = await page.getByLabel("View week").locator("option").allTextContents();
  assert(historyOptions.length === 3, `Expected current, history, and legacy options, got ${historyOptions.length}.`);
  assert(historyOptions.filter((option) => option.includes("History")).length === 1, "Expected one historical week.");

  const historyValue = await page.getByLabel("View week").locator("option").evaluateAll((options) => {
    const history = options.find((option) => option.textContent?.includes("History"));
    return history?.value;
  });
  assert(historyValue, "Historical option had no value.");
  await page.getByLabel("View week").selectOption(historyValue);
  await page.getByText("Completed week: This history is read-only.").waitFor();
  await page.getByRole("button", { name: "Learner", exact: true }).click();
  assert(await page.locator(".task-button").count() === 4 && await page.locator(".task-check-button:disabled").count() === 4, "Removed Wednesday task still appeared in history or controls were not disabled.");

  await page.getByLabel("View week").selectOption("legacy");
  await page.getByText("Legacy / Unassigned: These records are preserved exactly as they were.").waitFor();
  assert(await page.locator(".task-button").count() === 5 && await page.locator(".task-check-button:disabled").count() === 5, "Legacy task controls were not read-only.");

  await enterParentView();
  const addLearnerForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Add another learner" }) });
  await addLearnerForm.getByLabel("Learner name").fill("Second Learner");
  await addLearnerForm.getByRole("button", { name: "Add learner" }).click();
  await learnerSelect.locator("option", { hasText: "Second Learner" }).waitFor({ state: "attached" });
  const secondLearnerValue = await learnerSelect.inputValue();
  assert(secondLearnerValue !== firstLearnerValue, "Adding a learner did not switch profiles.");
  assert(await learnerSelect.locator("option").count() === 2, "Expected two learner profiles.");
  await page.getByText("Current", { exact: true }).waitFor();
  assert(await page.locator(".task-button").count() === 0, "New learner did not start with an empty week.");

  const addTaskForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Add a task" }) });
  await addTaskForm.getByLabel("Task name").fill("Second learner math");
  await addTaskForm.getByRole("button", { name: "Add to the week" }).click();
  await page.getByRole("button", { name: "Learner", exact: true }).click();
  const secondLearnerTask = page.locator(".task-button").filter({ hasText: "Second learner math" });
  await secondLearnerTask.click();
  await page.getByRole("button", { name: "Start this task" }).click();
  await page.getByRole("button", { name: "I finished it" }).click();
  await secondLearnerTask.getByText("Completed · Tap to undo").waitFor();
  assert(/20\s*\/\s*20 XP/.test(await page.locator(".tracker").filter({ hasText: "Weekly" }).innerText()), "Second learner XP total was incorrect.");

  await learnerSelect.selectOption(firstLearnerValue);
  await page.getByLabel("View week").waitFor();
  assert(await page.getByText("Second learner math", { exact: true }).count() === 0, "Second learner task leaked into the first learner.");
  await page.getByLabel("View week").selectOption("legacy");
  await page.getByText("Legacy / Unassigned: These records are preserved exactly as they were.").waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetrics = await page.evaluate(() => {
    const grid = document.querySelector(".week-grid");
    const task = document.querySelector(".task-button");
    if (!(grid instanceof HTMLElement) || !(task instanceof HTMLElement)) throw new Error("Mobile controls missing.");
    const gridStyle = getComputedStyle(grid);
    const taskRect = task.getBoundingClientRect();
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      gridWidth: grid.getBoundingClientRect().width,
      gridOverflowX: gridStyle.overflowX,
      taskHeight: taskRect.height,
      taskWidth: taskRect.width,
    };
  });
  assert(mobileMetrics.bodyWidth <= mobileMetrics.viewportWidth, `Body overflowed mobile viewport: ${JSON.stringify(mobileMetrics)}`);
  assert(mobileMetrics.gridWidth <= mobileMetrics.viewportWidth, `Week grid exceeded mobile viewport: ${JSON.stringify(mobileMetrics)}`);
  assert(mobileMetrics.gridOverflowX === "auto", `Week grid was not horizontally scrollable: ${JSON.stringify(mobileMetrics)}`);
  assert(mobileMetrics.taskHeight >= 44 && mobileMetrics.taskWidth >= 44, `Mobile tap target was too small: ${JSON.stringify(mobileMetrics)}`);

  await page.screenshot({ path: "/var/folders/8j/c8ymmxss3h11g4fs8yl9tccc0000gn/T/opencode/weekly-plans-mobile.png", fullPage: true });
  assert(forbiddenRequests.length === 0, `Browser contacted production Supabase: ${forbiddenRequests.join(", ")}`);
  const functionalHttpErrors = httpErrors.filter((error) => !error.url.endsWith("/favicon.ico"));
  assert(functionalHttpErrors.length === 0, `Browser HTTP errors: ${JSON.stringify(functionalHttpErrors)}`);
  const functionalConsoleErrors = consoleErrors.filter((error) => !error.includes("status of 404"));
  assert(functionalConsoleErrors.length === 0, `Browser console errors: ${functionalConsoleErrors.join(" | ")}`);

  console.log(JSON.stringify({
    test: "browser_weekly_plan_flow",
    status: "PASS",
    setupTaskCount,
    firstPlanOptions,
    completedWeeklyText: completedWeeklyText.replaceAll("\n", " | "),
    undoneWeeklyText: undoneWeeklyText.replaceAll("\n", " | "),
    historyOptions,
    removedWednesdayTask: true,
    historicalDisabledTasks: 4,
    legacyDisabledTasks: 5,
    learnerProfiles: 2,
    secondLearnerIsolated: true,
    mobileMetrics,
    productionSupabaseRequests: forbiddenRequests.length,
    ignoredAsset404s: httpErrors.filter((error) => error.url.endsWith("/favicon.ico")),
    functionalHttpErrors: functionalHttpErrors.length,
    functionalConsoleErrors: functionalConsoleErrors.length,
  }));
} catch (error) {
  console.error(JSON.stringify({ consoleErrors, httpErrors, bodyText: await page.locator("body").innerText() }, null, 2));
  throw error;
} finally {
  await browser.close();
}
