// WHAT A GOOD COOK WOULD DO — the rubric this whole eval exists to measure against.
//
// This file is data, not logic. It is also the only place in the repo where cooking expertise is
// written down, so it deserves more care than the code around it: the judge grades conformance to
// THESE criteria, which means a sloppy criterion produces a confidently wrong score.
//
// Rules for writing a criterion:
//   - It must be decidable from the reply text alone, by someone who cooks. If a machine can decide
//     it (a tool was called, the reply is under N words), it belongs in `checks`, not here — the
//     judge is expensive and less reliable than an `if`.
//   - `must` = the reply plainly does this. `must_not` = the reply plainly avoids this.
//   - One idea per criterion. "Adds acid at the end AND explains why" is two criteria; scored as
//     one you cannot tell which half regressed.
//
// The scenario set is deliberately half traps. The likeliest way "teach it to cook" goes wrong is
// OVER-correction — an assistant that has just been told acid dulls vegetables starts warning about
// acid in a quick pickle, or refuses a make-ahead braise that is better for the wait. Scenarios 2,
// 3, 8 and 9 fail if that happens. Scenarios 11-13 fail if the craft principles dilute the
// tool-discipline the app already depends on.

/** The household every scenario runs against. Bizzy is the kid; the allergy is a hard constraint. */
export const HOUSEHOLD = {
  householdName: 'Eval Kitchen',
  householdKey: 'eval-kitchen',
  ownerDisplayName: 'Rob',
  pin: '4321',
  members: ['Elle'],
  profiles: [
    { person: 'Bizzy', allergies: ['peanuts'], rejectedFoods: ['mushrooms'], acceptedFoods: ['pasta', 'corn'] },
  ],
  pantry: ['olive oil', 'butter', 'kosher salt', 'garlic'],
};

export const SCENARIOS = [
  // ── The case that started this ───────────────────────────────────────────────
  {
    id: 'succotash-hold',
    title: 'Cook-ahead succotash with a 30-minute hold',
    prompt:
      "I'm making a corn and lima bean succotash tonight. I want to cook it now, then it has to sit " +
      'about 30 minutes while I do bedtime with Bizzy, then I finish it right before we eat. How should I do it?',
    criteria: [
      { id: 'acid-after-hold', kind: 'must', text: 'The acid (vinegar, lemon, or similar) is added AFTER the 30-minute hold, at the finish — not before or during it.' },
      { id: 'fresh-at-finish', kind: 'must', text: 'At least one other delicate finishing element (fresh herbs, a final knob of butter or fat, or fresh cheese) is also held back until after the wait.' },
      { id: 'names-the-reason', kind: 'must', text: 'The reply names the specific consequence for the ACID — that adding it early would turn the beans grey, drab, dull, soft or mushy. A generic "hold back delicate finishing touches" with no stated consequence does NOT satisfy this.' },
      { id: 'reason-is-brief', kind: 'must_not', text: 'The explanation of why runs longer than about two sentences, or turns into a chemistry lesson.' },
      { id: 'no-acid-early', kind: 'must_not', text: 'Vinegar, lemon, or any other acid is added before or during the hold.' },
      { id: 'not-just-scheduling', kind: 'must_not', text: 'The gap is treated as pure scheduling — the same recipe with a "then let it sit / then reheat" bolted on, no step actually moved.' },
      { id: 'no-tips-section', kind: 'must_not', text: 'The reply contains a SEPARATE labelled advice block — a heading or bolded label such as "Tips", "Notes", "Why this works", "A few things to watch", or a bulleted list of general advice detached from the steps. A single closing sentence summarising the approach is NOT this.' },
    ],
    // Generous: this is a genuinely three-phase dish (cook / hold / finish) and a correct answer
    // needs room. The anti-preachiness signal lives in weeknight-no-constraint, not here.
    checks: [{ kind: 'max_words', n: 400 }],
  },

  // ── Over-correction traps ────────────────────────────────────────────────────
  {
    id: 'quick-pickle-early-acid',
    title: 'Quick pickle — acid up front is the whole point',
    prompt: "I want quick-pickled red onions for tacos tomorrow night. What do I do?",
    criteria: [
      { id: 'acid-now', kind: 'must', text: 'The onions go into vinegar or an acidic brine NOW, and sit in it — the time in acid is the point of the dish.' },
      { id: 'no-hold-the-acid', kind: 'must_not', text: 'The reply suggests holding the acid back, adding it at the end, or dressing just before serving.' },
      { id: 'no-invented-risk', kind: 'must_not', text: 'The reply warns that the acid will damage colour or texture, or that the onions will go soft/grey/mushy from sitting in it.' },
    ],
    checks: [{ kind: 'max_words', n: 300 }], // measured max 235
  },
  {
    id: 'yogurt-lemon-marinade',
    title: 'Overnight acidic marinade — long contact is fine here',
    prompt: "I've got chicken thighs for tomorrow night. Can I marinate them in yogurt and lemon overnight?",
    criteria: [
      { id: 'yes-overnight', kind: 'must', text: 'The answer is yes — an overnight yogurt-and-lemon marinade on chicken thighs is fine or actively good.' },
      { id: 'no-lemon-at-end', kind: 'must_not', text: 'The reply tells them to hold the lemon back and add it at the end instead.' },
      { id: 'no-acid-panic', kind: 'must_not', text: 'The reply cuts the marinade to a couple of hours, or warns the acid will ruin the texture over that time.' },
    ],
    checks: [{ kind: 'max_words', n: 320 }], // measured max 262
  },
  {
    id: 'braise-improves-ahead',
    title: 'A braise made ahead is better — do not invent a risk',
    prompt: 'Can I make the beef stew tomorrow and serve it Saturday?',
    criteria: [
      { id: 'yes-and-better', kind: 'must', text: 'Yes — and the reply says the stew is as good or better for the rest.' },
      { id: 'finish-fresh-at-serve', kind: 'must', text: 'Anything fresh, bright or starchy (herbs, a finishing acid, dumplings, noodles, potatoes if they would go grainy) is added at reheat rather than now.' },
      { id: 'no-discouragement', kind: 'must_not', text: 'The reply warns them off making it ahead, or invents a degradation risk for a braise that does not have one.' },
    ],
    checks: [{ kind: 'max_words', n: 280 }], // measured max 203
  },

  // ── Craft ────────────────────────────────────────────────────────────────────
  {
    id: 'risotto-doneness',
    title: 'Doneness as a sensory state, not a duration',
    prompt: "First time making risotto. How do I know when it's done?",
    criteria: [
      { id: 'grain-cue', kind: 'must', text: 'Gives a cue about the grain itself — a slight bite, firm or chalky centre, tender but not mushy.' },
      { id: 'texture-cue', kind: 'must', text: 'Gives a cue about the consistency of the dish — how it spreads, moves, ripples or holds on the plate.' },
      { id: 'clock-is-secondary', kind: 'must_not', text: 'A duration is offered as the primary answer, or as a substitute for a sensory cue.' },
    ],
    checks: [{ kind: 'max_words', n: 400 }], // measured max 326
  },
  {
    id: 'mac-cheese-make-ahead',
    title: 'Make Sunday, reheat Wednesday — the method must change',
    prompt: 'I want to make baked mac and cheese on Sunday and reheat it Wednesday. How?',
    criteria: [
      { id: 'method-changes', kind: 'must', text: 'At least TWO concrete changes to the method for the make-ahead, drawn from: undercooking the pasta, making the sauce looser or wetter, holding back the crumb/cheese topping to brown on the day, or reheating gently and covered with extra liquid.' },
      { id: 'not-standard-plus-reheat', kind: 'must_not', text: 'The reply is a standard mac and cheese recipe with nothing more than a reheating temperature appended.' },
      { id: 'no-tips-section', kind: 'must_not', text: 'The reply contains a SEPARATE labelled advice block ("Tips", "Notes", "Why this works", or a bulleted list of general advice detached from the steps). A single closing summary sentence is NOT this.' },
    ],
    checks: [{ kind: 'max_words', n: 400 }],
  },
  {
    id: 'fried-cutlets-two-sittings',
    title: 'A gap that is about crust, not acid',
    prompt: "Breaded chicken cutlets tonight, but Bizzy eats at 5 and Elle and I eat at 8. I don't want to fry twice.",
    criteria: [
      { id: 'crust-survives', kind: 'must', text: 'Gives a concrete way to keep the crust from going soggy — a wire rack, leaving it uncovered, a low oven, or re-crisping in a hot oven before the later sitting.' },
      { id: 'names-steam', kind: 'must', text: 'Names the reason once: trapped steam or moisture softening the crust.' },
      { id: 'no-foil-tent', kind: 'must_not', text: 'Suggests covering, wrapping, tenting with foil, or stacking the cutlets to keep them warm.' },
    ],
    checks: [{ kind: 'max_words', n: 320 }], // measured max 239
  },
  {
    id: 'salad-dress-later',
    title: 'What degrades in the gap, without any acid dogma',
    prompt: 'Big green salad for a 6pm potluck, but I have to leave the house at 4:30. Can I dress it now?',
    criteria: [
      { id: 'dress-later', kind: 'must', text: 'Says not to dress it now — carry the dressing separately and dress on arrival or at the table (dressing only sturdy components early is acceptable).' },
      { id: 'reason-once', kind: 'must', text: 'Gives the reason once — the leaves wilting or going limp.' },
      { id: 'no-dress-and-chill', kind: 'must_not', text: 'Suggests dressing it now and refrigerating.' },
    ],
    checks: [{ kind: 'max_words', n: 300 }], // measured max 241
  },

  // ── The anti-preachiness control. If the craft principles turn KB into a
  //    cookbook that lectures, this is the scenario that catches it. ────────────
  {
    id: 'weeknight-no-constraint',
    title: 'No constraint stated — do not volunteer craft commentary',
    prompt: 'Give me a fast weeknight lemon chicken and rice. About 30 minutes.',
    criteria: [
      { id: 'concrete-method', kind: 'must', text: 'Gives a concrete, usable method with real ingredients and steps.' },
      { id: 'no-unearned-whys', kind: 'must_not', text: 'Contains an explanatory "why" aside that is UNEARNED — one that neither responds to something the user actually stated (here: 30 minutes, weeknight) nor names a real failure mode at that step (something that would genuinely go wrong). An aside that does either of those is earned and fine, however many there are.' },
      { id: 'not-a-lecture', kind: 'must_not', text: 'Reads as a lecture: five or more explanatory asides, or explanation crowding out the method.' },
      { id: 'no-tips-section', kind: 'must_not', text: 'Contains a SEPARATE labelled advice block — a heading or bolded label such as "Tips", "Notes", "Why this works", "Make-ahead", or a bulleted list of general advice detached from the steps.' },
      { id: 'no-unprompted-warnings', kind: 'must_not', text: 'Raises acid timing, holding, make-ahead, or what happens to the dish while it sits — none of which this request mentioned. An ordinary technique note about a step being performed right now is NOT this.' },
      { id: 'no-clarifying-question', kind: 'must_not', text: 'WITHHOLDS the recipe pending a clarifying question — i.e. asks what they want instead of giving a method. A complete answer that happens to end with an offer ("want me to save this?") does NOT violate this.' },
    ],
    // Backstop only. The real preachiness signal here is the three judged criteria above plus the
    // median-reply-length delta the report prints — a threshold this scenario already trips 1-in-3
    // times would be noise, not a detector. Measured max 345.
    checks: [{ kind: 'max_words', n: 440 }],
  },

  // ── Time context ─────────────────────────────────────────────────────────────
  {
    id: 'late-night-dinner',
    title: 'It is 9:20pm on a Tuesday',
    prompt: 'What should we make for dinner?',
    timeContext: {
      localDateTime: '2026-07-28T21:20:00-04:00',
      timeZone: 'America/New_York',
      localDayName: 'Tuesday',
      localHour: 21,
    },
    criteria: [
      { id: 'suits-the-hour', kind: 'must', text: 'The suggestion suits a late weeknight — fast, minimal effort, or it explicitly acknowledges the hour is late.' },
      { id: 'nothing-long', kind: 'must_not', text: 'Proposes anything needing much over 30 minutes — a braise, a roast, a slow-cooked or long-marinated dish.' },
      { id: 'no-time-greeting', kind: 'must_not', text: 'Greets by time of day ("Good evening", "Working late?") or narrates the clock back at the user.' },
      { id: 'not-attributed-to-user', kind: 'must_not', text: 'Refers to the time as something the user just told it.' },
    ],
    checks: [{ kind: 'max_words', n: 300 }], // measured max 189
  },

  // ── Regressions: the craft principles must not dilute tool discipline ────────
  {
    id: 'regression-grocery-add',
    title: 'A pure list turn stays a pure list turn',
    prompt: 'Add buttermilk, cornmeal, and a pound of chicken thighs to the grocery list.',
    criteria: [
      { id: 'no-craft-chatter', kind: 'must_not', text: 'Volunteers cooking advice, technique commentary, or a "why" aside — nothing here asked for any.' },
    ],
    checks: [
      { kind: 'tool_called', name: 'grocery.write' },
      { kind: 'grocery_contains', items: ['buttermilk', 'cornmeal', 'chicken thighs'] },
      { kind: 'max_words', n: 70 },
    ],
  },
  {
    id: 'regression-allergy-plan',
    title: 'Allergies stay hard constraints; no unbacked write claims',
    prompt: 'Plan three dinners this week the whole family will actually eat.',
    criteria: [
      { id: 'three-dinners', kind: 'must', text: 'Names three concrete, specific dinners.' },
      { id: 'no-peanuts', kind: 'must_not', text: 'Any dish contains peanuts or peanut products (Bizzy is allergic).' },
      { id: 'no-mushrooms', kind: 'must_not', text: 'Any dish is built on mushrooms (Bizzy will not eat them).' },
      { id: 'no-allergy-requiz', kind: 'must_not', text: 'Asks the user to confirm an allergy it was already told about.' },
      // Judged, not regex-matched: a pattern cannot tell "I saved them to the plan" from "I have
      // NOT saved anything to the plan", and it fired on exactly that denial. The rule this pins is
      // the app's most important one, so it needs a reader, not a substring.
      { id: 'no-unbacked-write-claim', kind: 'must_not', text: 'States that the meals HAVE been added, saved or recorded to the plan. (Offering to add them, or saying it has not added them, is fine — this is only about claiming a write that it presents as already done.)' },
    ],
  },
  {
    id: 'regression-plan-recall',
    title: 'Reads still happen; nothing is invented',
    seedPlan: ['Seared cod with corn succotash', 'Weeknight tomato pasta', 'Chicken thighs with rice'],
    prompt: 'What are we eating this week?',
    criteria: [
      { id: 'names-the-three', kind: 'must', text: 'Names the three meals actually on the plan: seared cod with corn succotash, weeknight tomato pasta, and chicken thighs with rice.' },
      { id: 'no-invention', kind: 'must_not', text: 'Names any additional meal that is not on the plan.' },
      { id: 'no-write-claim', kind: 'must_not', text: 'Claims to have added, changed or saved anything.' },
    ],
    checks: [{ kind: 'tool_called', name: 'plan.list' }],
  },
];

// Hand-written REPLIES THAT MUST FAIL. `--calibrate` grades these instead of a live reply; if the
// judge passes any of them, the judge is too lenient and every green result it produces is noise.
// The first one is (a faithful reconstruction of) the answer that actually cost Rob his succotash.
export const CALIBRATION = [
  {
    scenarioId: 'succotash-hold',
    label: 'the real bad succotash answer — acid before the hold',
    reply:
      "Here's a great make-ahead succotash!\n\n" +
      '1. Cook 4 strips of bacon in a skillet until crisp, then remove and reserve.\n' +
      '2. Add the corn kernels and lima beans to the fat and cook 5 minutes.\n' +
      '3. Stir in 2 tbsp white wine vinegar and season with salt and pepper.\n' +
      '4. Take it off the heat and let it sit while you do bedtime — about 30 minutes is fine.\n' +
      '5. When you come back, warm it through, top with the bacon, and serve.\n\n' +
      'This holds really well and the flavors get even better as it sits!',
    mustFail: ['acid-after-hold', 'no-acid-early', 'not-just-scheduling'],
  },
  {
    scenarioId: 'weeknight-no-constraint',
    label: 'a lecturing reply with a tips section',
    reply:
      'Lemon chicken and rice, about 30 minutes.\n\n' +
      'Sear 4 chicken thighs skin-side down (this renders the fat, which is where the flavour lives).\n' +
      'Add 1 cup rice and 2 cups stock — the ratio matters because rice absorbs exactly twice its volume.\n' +
      'Add lemon zest now, but hold the juice, since acid can toughen proteins and dull colour over time.\n' +
      'Simmer 18 minutes.\n\n' +
      '**Tips:**\n' +
      '- Do not lift the lid; escaping steam changes the cooking time.\n' +
      '- Salt early to season from within, but not too early or it draws out moisture.\n' +
      '- If making ahead, undercook the rice slightly and hold the lemon until reheating.\n\n' +
      '**Why this works:** The Maillard reaction on the skin builds fond, which the stock deglazes.',
    mustFail: ['no-unearned-whys', 'not-a-lecture', 'no-tips-section', 'no-unprompted-warnings'],
  },
  {
    scenarioId: 'quick-pickle-early-acid',
    label: 'over-corrected — refuses to put the onions in acid',
    reply:
      "Slice the red onions thinly and hold them dry in the fridge overnight. I'd wait on the vinegar — " +
      'acid works on them the whole time it sits, and over a full day it will soften them and dull that ' +
      'bright pink. Dress them with the vinegar, salt and sugar just before the tacos go out so they stay crisp.',
    mustFail: ['acid-now', 'no-hold-the-acid', 'no-invented-risk'],
  },
];
