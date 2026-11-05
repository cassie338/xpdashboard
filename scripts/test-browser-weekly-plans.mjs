import { chromium } from "playwright-core";

const appUrl = process.env.APP_URL ?? "http://localhost:3100";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const consoleErrors = [];
const forbiddenRequests = [];
const httpErrors = [];
const parentBirthday = "01/02/90";
let testedParentGateFailure = false;
let testedParentNavigation = false;

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("request", (request) => {
  const hostname = new URL(request.url()).hostname;
  if (hostname.endsWith("supabase.co")) forbiddenRequests.push(request.url());
});
page.on("response", (response) => {
  if (response.status() >= 400)
    httpErrors.push({ status: response.status(), url: response.url() });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function enterParentView() {
  await page.getByRole("button", { name: "Parent", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Enter the parent birthday",
  });
  if (!testedParentGateFailure) {
    await dialog.getByLabel("Parent birthday").fill("01/02/91");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog
      .getByText("That answer is not correct.", { exact: true })
      .waitFor();
    testedParentGateFailure = true;
  }
  await dialog.getByLabel("Parent birthday").fill(parentBirthday);
  await dialog.getByRole("button", { name: "Continue" }).click();
  const parentNavigation = page.getByRole("navigation", {
    name: "Parent dashboard sections",
  });
  await parentNavigation
    .getByRole("tab", { name: "Weekly Planning", exact: true })
    .waitFor();
  if (!testedParentNavigation) {
    assert(
      (await parentNavigation.getByRole("tab").count()) === 1,
      "Parent navigation showed a section other than Weekly Planning.",
    );
    for (const hiddenSection of ["Overview", "Learner Profile", "Academics", "Quest Builder"]) {
      assert(
        (await parentNavigation.getByRole("tab", { name: hiddenSection, exact: true }).count()) === 0,
        `${hiddenSection} remained visible in parent navigation.`,
      );
    }
    testedParentNavigation = true;
  }
  await page.getByRole("heading", { name: "Weekly plan" }).waitFor();
}

async function verifyCelebrationDate(day) {
  const celebration = page.locator(".celebration");
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    new Date(),
  );
  if (day === today) {
    await celebration.waitFor({ state: "visible" });
    await celebration.getByRole("button", { name: "Awesome!" }).click();
  } else {
    assert(
      !(await celebration.isVisible()),
      `Completing ${day} work on ${today} triggered a daily celebration.`,
    );
  }
}

async function assertTaskCardsContained(viewport) {
  const overflowingTaskCards = await page.evaluate(() =>
    [...document.querySelectorAll(".day-card")].flatMap((dayCard) => {
      const dayRect = dayCard.getBoundingClientRect();
      return [...dayCard.querySelectorAll(".task-button")]
        .filter((taskCard) => {
          const taskRect = taskCard.getBoundingClientRect();
          return (
            taskRect.left < dayRect.left - 1 ||
            taskRect.right > dayRect.right + 1
          );
        })
        .map((taskCard) => taskCard.textContent?.trim() ?? "Unknown task");
    }),
  );
  assert(
    overflowingTaskCards.length === 0,
    `${viewport} task cards exceeded their day columns: ${JSON.stringify(overflowingTaskCards)}`,
  );
}

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "First time? Create the family account" })
    .click();
  const email = `browser-${crypto.randomUUID()}@example.invalid`;
  await page.getByLabel("Email").fill(email);
  await page
    .getByLabel("Password")
    .fill(`Local-only-${crypto.randomUUID()}-A1!`);
  await page.getByLabel("Parent birthday").fill(parentBirthday);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Anywhere" })
    .waitFor({ timeout: 15000 });
  await page.getByRole("img", { name: "Vail Valley Unbound" }).waitFor();
  await page.getByText("Remote learning", { exact: true }).first().waitFor();

  await page
    .getByText(
      "Set up this week: A parent can include or exclude the tasks below",
    )
    .waitFor();
  assert(
    (await page.getByText("Unassigned", { exact: true }).count()) === 0,
    "First-week setup showed Unassigned instead of dates.",
  );
  assert(
    /^[A-Z]{3} \d{1,2}$/i.test(
      await page.locator(".day-card").first().locator("p").first().innerText(),
    ),
    "First-week setup date was missing.",
  );

  await enterParentView();
  const setupTaskCount = await page
    .getByRole("button", { name: /^Exclude / })
    .count();
  assert(
    setupTaskCount === 5,
    `Expected 5 included setup tasks, got ${setupTaskCount}.`,
  );
  await page
    .getByRole("button", { name: "Exclude Write one great paragraph" })
    .click();
  await page
    .getByRole("button", { name: "Include Write one great paragraph" })
    .click();
  await page
    .getByRole("button", { name: "Exclude Write one great paragraph" })
    .waitFor();

  await page.getByRole("button", { name: "Start first weekly plan" }).click();
  await page
    .locator(".weekly-editor .status-badge")
    .getByText("Current", { exact: true })
    .waitFor();
  const firstPlanOptions = await page
    .getByLabel("View week")
    .locator("option")
    .allTextContents();
  assert(
    firstPlanOptions.length === 2,
    `Expected current plus legacy options, got ${firstPlanOptions.length}.`,
  );
  assert(
    firstPlanOptions.some((option) => option.includes("Current")),
    "Current week option was missing.",
  );
  assert(
    firstPlanOptions.some((option) => option === "Legacy / Unassigned"),
    "Legacy option was missing.",
  );

  const wednesdayPlan = page
    .locator(".parent-day")
    .filter({ hasText: "Wednesday" });
  if (!(await wednesdayPlan.evaluate((element) => element.open)))
    await wednesdayPlan.locator(":scope > summary").click();
  const wednesdayReward = wednesdayPlan.getByLabel("Daily reward");
  await wednesdayReward.fill("Choose tonight's family game");
  await wednesdayReward.press("Tab");
  await wednesdayPlan.locator(".support-select").selectOption("with_parent");

  await page.getByRole("button", { name: "Learner", exact: true }).click();
  const firstTask = page
    .locator(".day-card")
    .filter({
      has: page.getByRole("heading", { name: "Wednesday", exact: true }),
    })
    .locator(".task-button")
    .first();
  await firstTask.click();
  await page
    .getByRole("heading", { name: "Write one great paragraph", exact: true })
    .waitFor();
  await page
    .locator(".focus-card .support-badge")
    .filter({ hasText: "Do with a parent" })
    .waitFor();
  await page.getByText("Choose tonight's family game").last().waitFor();
  const helpButton = page.getByRole("button", { name: "I need help" });
  const helpButtonColors = await helpButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, backgroundColor: style.backgroundColor };
  });
  assert(
    helpButtonColors.color !== helpButtonColors.backgroundColor,
    `Secondary learner button had unreadable text: ${JSON.stringify(helpButtonColors)}`,
  );
  const independentMondayTask = page
    .locator(".day-card")
    .filter({
      has: page.getByRole("heading", { name: "Monday", exact: true }),
    })
    .locator(".task-button")
    .first();
  await independentMondayTask
    .getByText("Independent work", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Start with my parent" }).click();
  await page.getByRole("button", { name: "I need help" }).click();
  await page
    .getByText("Your help request is saved for your parent.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "I finished it" }).click();
  await firstTask.getByText("Completed · Tap to undo").waitFor();
  const completedWeeklyText = await page
    .locator(".tracker")
    .filter({ hasText: "Weekly" })
    .innerText();
  assert(
    /25\s*\/\s*115 XP/.test(completedWeeklyText),
    `Unexpected completion total: ${completedWeeklyText}`,
  );
  assert(
    /25/.test(await page.locator(".lifetime-xp").innerText()),
    "Lifetime XP did not increase after completion.",
  );
  await page
    .locator(".treasure-box")
    .getByText("Coming soon", { exact: true })
    .waitFor();

  await verifyCelebrationDate("Wednesday");

  await firstTask
    .getByRole("button", { name: "Undo Write one great paragraph" })
    .click();
  await firstTask
    .getByText("Completed · Tap to undo", { exact: true })
    .waitFor({ state: "detached" });
  await firstTask.getByText("Do with a parent", { exact: true }).waitFor();
  const undoneWeeklyText = await page
    .locator(".tracker")
    .filter({ hasText: "Weekly" })
    .innerText();
  assert(
    /0\s*\/\s*115 XP/.test(undoneWeeklyText),
    `Unexpected undo total: ${undoneWeeklyText}`,
  );
  assert(
    /0/.test(await page.locator(".lifetime-xp").innerText()),
    "Lifetime XP did not reflect the compensating undo event.",
  );

  const mondayTask = page
    .locator(".day-card")
    .filter({ has: page.getByRole("heading", { name: "Monday", exact: true }) })
    .locator(".task-button")
    .first();
  await mondayTask
    .getByRole("button", { name: "Complete Math practice" })
    .click();
  await mondayTask.getByText("Completed · Tap to undo").waitFor();
  await verifyCelebrationDate("Monday");
  await mondayTask.getByRole("button", { name: "Undo Math practice" }).click();
  await mondayTask.getByText("Math", { exact: true }).waitFor();

  await page
    .getByLabel("Want to choose something else?")
    .selectOption({ label: "Thursday: Fold and put away laundry" });
  await page.getByRole("button", { name: "Swap this activity" }).click();
  await page.getByLabel("What do you want to do instead?").fill("Piano");
  await page.getByRole("button", { name: "Ask my parent" }).click();
  await page.getByText("Waiting for parent approval:").waitFor();
  assert(
    await page.getByRole("button", { name: "Start this task" }).isDisabled(),
    "A pending swap did not pause the original activity.",
  );

  await enterParentView();
  const swapPanel = page.locator(".attention-panel");
  await swapPanel
    .getByText("Fold and put away laundry → Piano", { exact: true })
    .waitFor();
  await swapPanel.getByRole("button", { name: "Approve swap" }).click();
  const swapHistory = page
    .locator(".utility-card")
    .filter({ hasText: "Swap history" });
  await swapHistory.locator("summary").click();
  await swapHistory.getByText("approved", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Learner", exact: true }).click();
  const pianoTask = page
    .locator(".day-card")
    .filter({
      has: page.getByRole("heading", { name: "Thursday", exact: true }),
    })
    .locator(".task-button")
    .filter({ hasText: "Piano" });
  await pianoTask.waitFor();
  assert(
    (await page
      .locator(".day-card .task-button")
      .filter({ hasText: "Fold and put away laundry" })
      .count()) === 0,
    "Approved swap left the original activity active.",
  );
  await pianoTask.locator(".task-select-button").click();
  assert(
    await page.getByRole("button", { name: "Daily swap used" }).isDisabled(),
    "Approved replacement could be swapped again on the same day.",
  );
  await pianoTask.getByRole("button", { name: "Complete Piano" }).click();
  await pianoTask.getByText("Completed · Tap to undo").waitFor();
  await verifyCelebrationDate("Thursday");
  assert(
    /15\s*\/\s*115 XP/.test(
      await page.locator(".tracker").filter({ hasText: "Weekly" }).innerText(),
    ),
    "Replacement did not inherit the original XP.",
  );
  await pianoTask.getByRole("button", { name: "Undo Piano" }).click();

  await enterParentView();
  const parentWednesday = page
    .locator(".parent-day")
    .filter({ hasText: "Wednesday" });
  if (!(await parentWednesday.evaluate((element) => element.open)))
    await parentWednesday.locator(":scope > summary").click();
  const writingStruggle = parentWednesday
    .locator(".parent-task-row")
    .filter({ hasText: "Write one great paragraph" });
  await writingStruggle
    .getByText("Add parent feedback", { exact: true })
    .waitFor();
  await writingStruggle.locator(".task-observations > summary").click();
  await writingStruggle
    .getByLabel("Parent feedback for Write one great paragraph")
    .fill("Mixed up the topic sentence and supporting detail.");
  await writingStruggle
    .getByRole("button", { name: "Save parent feedback" })
    .click();
  await writingStruggle
    .getByText("Mixed up the topic sentence and supporting detail.", {
      exact: true,
    })
    .waitFor();
  assert(
    /0\s*\/\s*115 XP/.test(
      await page.locator(".tracker").filter({ hasText: "Weekly" }).innerText(),
    ),
    "Saving a parent-reported struggle changed XP.",
  );
  const parentTuesday = page
    .locator(".parent-day")
    .filter({ hasText: "Tuesday" });
  if (!(await parentTuesday.evaluate((element) => element.open)))
    await parentTuesday.locator(":scope > summary").click();
  const readingFeedback = parentTuesday
    .locator(".parent-task-row")
    .filter({ hasText: "Read for 20 minutes" });
  await readingFeedback.locator(".support-select").selectOption("with_parent");
  await readingFeedback
    .getByText("Add parent feedback", { exact: true })
    .waitFor();
  await readingFeedback.locator(".task-observations > summary").click();
  await readingFeedback
    .getByLabel("Parent feedback for Read for 20 minutes")
    .fill("Retelling the page aloud helped connect the main ideas.");
  await readingFeedback
    .getByRole("button", { name: "Save parent feedback" })
    .click();
  if (!(await parentWednesday.evaluate((element) => element.open)))
    await parentWednesday.locator(":scope > summary").click();
  const removeWednesdayButton = page.getByRole("button", {
    name: "Remove Write one great paragraph",
  });
  await removeWednesdayButton.click();
  await removeWednesdayButton.waitFor({ state: "detached" });
  const planAhead = page
    .locator(".utility-card")
    .filter({ hasText: "Plan following week" });
  if (!(await planAhead.evaluate((element) => element.open)))
    await planAhead.locator("summary").click();
  await planAhead
    .getByRole("button", { name: "Plan following week", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll("header select.week-picker")[1]
        ?.querySelectorAll("option").length === 3,
  );
  const plannedOptions = await page
    .getByLabel("View week")
    .locator("option")
    .allTextContents();
  assert(
    plannedOptions.length === 3,
    `Expected current, upcoming, and legacy options, got ${plannedOptions.length}.`,
  );
  assert(
    plannedOptions.filter((option) => option.includes("Current")).length === 1,
    "Planning ahead closed the current week.",
  );
  assert(
    plannedOptions.filter((option) => option.includes("Upcoming")).length === 1,
    "Expected one upcoming week.",
  );
  assert(
    plannedOptions.every((option) => !option.includes("History")),
    "Planning ahead incorrectly created history.",
  );

  const currentValue = await page
    .getByLabel("View week")
    .locator("option")
    .evaluateAll((options) => {
      const current = options.find((option) =>
        option.textContent?.includes("Current"),
      );
      return current?.value;
    });
  assert(currentValue, "Current option had no value.");
  await page.getByLabel("View week").selectOption(currentValue);
  await page.getByRole("button", { name: "Learner", exact: true }).click();
  assert(
    (await page.locator(".task-button").count()) === 4 &&
      (await page.locator(".task-check-button:enabled").count()) === 4,
    "Planning ahead changed or locked the current week.",
  );

  await enterParentView();
  const upcomingValue = await page
    .getByLabel("View week")
    .locator("option")
    .evaluateAll((options) => {
      const upcoming = options.find((option) =>
        option.textContent?.includes("Upcoming"),
      );
      return upcoming?.value;
    });
  assert(upcomingValue, "Upcoming option had no value.");
  await page.getByLabel("View week").selectOption(upcomingValue);
  const upcomingTuesday = page
    .locator(".parent-day")
    .filter({ hasText: "Tuesday" });
  if (!(await upcomingTuesday.evaluate((element) => element.open)))
    await upcomingTuesday.locator(":scope > summary").click();
  const upcomingReading = upcomingTuesday
    .locator(".parent-task-row")
    .filter({ hasText: "Read for 20 minutes" });
  await upcomingReading
    .getByText("1 in running log", { exact: true })
    .waitFor();
  await upcomingReading.locator(".task-observations > summary").click();
  await upcomingReading
    .getByText("Retelling the page aloud helped connect the main ideas.", {
      exact: true,
    })
    .waitFor();
  const nextPlanAhead = page
    .locator(".utility-card")
    .filter({ hasText: "Plan following week" });
  if (!(await nextPlanAhead.evaluate((element) => element.open)))
    await nextPlanAhead.locator("summary").click();
  await nextPlanAhead
    .getByRole("button", { name: "Plan following week", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll("header select.week-picker")[1]
        ?.querySelectorAll("option").length === 4,
  );
  const multiWeekOptions = await page
    .getByLabel("View week")
    .locator("option")
    .allTextContents();
  assert(
    multiWeekOptions.filter((option) => option.includes("Upcoming")).length ===
      2,
    "A second upcoming week could not be planned.",
  );

  await page.getByLabel("View week").selectOption("legacy");
  await page
    .getByText(
      "Legacy / Unassigned: These records are preserved exactly as they were.",
    )
    .waitFor();
  await page.getByRole("button", { name: "Learner", exact: true }).click();
  assert(
    (await page.locator(".task-button").count()) === 5 &&
      (await page.locator(".task-check-button:disabled").count()) === 5,
    "Legacy task controls were not read-only.",
  );

  await assertTaskCardsContained("Desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetrics = await page.evaluate(() => {
    const grid = document.querySelector(".week-grid");
    const task = document.querySelector(".task-button");
    if (!(grid instanceof HTMLElement) || !(task instanceof HTMLElement))
      throw new Error("Mobile controls missing.");
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
  assert(
    mobileMetrics.bodyWidth <= mobileMetrics.viewportWidth,
    `Body overflowed mobile viewport: ${JSON.stringify(mobileMetrics)}`,
  );
  assert(
    mobileMetrics.gridWidth <= mobileMetrics.viewportWidth,
    `Week grid exceeded mobile viewport: ${JSON.stringify(mobileMetrics)}`,
  );
  assert(
    mobileMetrics.gridOverflowX === "auto",
    `Week grid was not horizontally scrollable: ${JSON.stringify(mobileMetrics)}`,
  );
  assert(
    mobileMetrics.taskHeight >= 44 && mobileMetrics.taskWidth >= 44,
    `Mobile tap target was too small: ${JSON.stringify(mobileMetrics)}`,
  );
  await assertTaskCardsContained("Mobile");

  await page.screenshot({
    path: "/var/folders/8j/c8ymmxss3h11g4fs8yl9tccc0000gn/T/opencode/weekly-plans-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("View week").selectOption(currentValue);
  await enterParentView();
  const parentMobileMetrics = await page.evaluate(() => {
    const editor = document.querySelector(".weekly-editor");
    const utilities = document.querySelector(".parent-utilities");
    if (!(editor instanceof HTMLElement) || !(utilities instanceof HTMLElement))
      throw new Error("Mobile parent controls missing.");
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      editorWidth: editor.getBoundingClientRect().width,
      utilitiesWidth: utilities.getBoundingClientRect().width,
    };
  });
  assert(
    parentMobileMetrics.bodyWidth <= parentMobileMetrics.viewportWidth &&
      parentMobileMetrics.editorWidth <= parentMobileMetrics.viewportWidth &&
      parentMobileMetrics.utilitiesWidth <= parentMobileMetrics.viewportWidth,
    `Parent dashboard overflowed mobile viewport: ${JSON.stringify(parentMobileMetrics)}`,
  );
  await page.screenshot({
    path: "/var/folders/8j/c8ymmxss3h11g4fs8yl9tccc0000gn/T/opencode/parent-dashboard-mobile.png",
    fullPage: true,
  });
  assert(
    forbiddenRequests.length === 0,
    `Browser contacted production Supabase: ${forbiddenRequests.join(", ")}`,
  );
  const functionalHttpErrors = httpErrors.filter(
    (error) => !error.url.endsWith("/favicon.ico"),
  );
  assert(
    functionalHttpErrors.length === 0,
    `Browser HTTP errors: ${JSON.stringify(functionalHttpErrors)}`,
  );
  const functionalConsoleErrors = consoleErrors.filter(
    (error) => !error.includes("status of 404"),
  );
  assert(
    functionalConsoleErrors.length === 0,
    `Browser console errors: ${functionalConsoleErrors.join(" | ")}`,
  );

  console.log(
    JSON.stringify({
      test: "browser_weekly_plan_flow",
      status: "PASS",
      setupTaskCount,
      firstPlanOptions,
      completedWeeklyText: completedWeeklyText.replaceAll("\n", " | "),
      undoneWeeklyText: undoneWeeklyText.replaceAll("\n", " | "),
      plannedOptions,
      multiWeekOptions,
      removedWednesdayTask: true,
      currentWeekEditableTasks: 4,
      legacyDisabledTasks: 5,
      mobileMetrics,
      parentMobileMetrics,
      productionSupabaseRequests: forbiddenRequests.length,
      ignoredAsset404s: httpErrors.filter((error) =>
        error.url.endsWith("/favicon.ico"),
      ),
      functionalHttpErrors: functionalHttpErrors.length,
      functionalConsoleErrors: functionalConsoleErrors.length,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        consoleErrors,
        httpErrors,
        bodyText: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
