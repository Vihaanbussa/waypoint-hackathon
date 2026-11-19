// Rule packs. Every deadline Waypoint tracks is a row in this file.
// Supporting a new visa type means adding rows here; clocks.js never changes.
//
// A rule row:
//   id, name      what the stop is called on the route
//   kind          'date'    due = profile[anchor] (+ offsetYears, + offsetDays)
//                 'counter' a number of days used against a limit
//   requires      profile fields that must be present for the rule to apply
//   unless        a profile flag that closes the clock when true
//   capField      a profile date the due date may not pass (whichever is shorter)
//   thresholds    { act, watch } in days left; defaults below
//   floor         the lowest risk this clock may show ('watch' or 'act')
//   reason        plain-language text; {field} and {field+N} print profile dates,
//                 {due} {elapsed} {used} {limit} {left} print computed values
//   variants      [{ when: field, reason }] picks another reason when a field is set
//   link          something the person does themselves (never done for them)
//   source        where the rule comes from. Not legal advice.

export const DEFAULT_THRESHOLDS = { act: 14, watch: 45 };
export const NOTICE_THRESHOLDS = { act: 21, watch: 45 };

const SRC = {
  ar11: { label: 'USCIS AR-11', url: 'https://www.uscis.gov/ar-11' },
  travel: {
    label: 'Study in the States, travel',
    url: 'https://studyinthestates.dhs.gov/students/traveling-as-an-international-student',
  },
  i9Students: {
    label: 'USCIS I-9 handbook 7.4.2',
    url: 'https://www.uscis.gov/i-9-central/form-i-9-resources/handbook-for-employers-m-274/70-evidence-of-employment-authorization-for-certain-categories/74-exchange-visitors-and-students/742-f-1-and-m-1-nonimmigrant-students',
  },
  unemployment: { label: 'Study in the States, unemployment counter' },
  termination: {
    label: 'USCIS, options after termination',
    url: 'https://www.uscis.gov/working-in-the-united-states/information-for-employers-and-employees/options-for-nonimmigrant-workers-following-termination-of-employment',
  },
  h1b: { label: 'USCIS H-1B', url: 'https://www.uscis.gov/working-in-the-united-states/h-1b-specialty-occupations' },
  j1: { label: 'State Department, J-1 common questions', url: 'https://j1visa.state.gov/participants/common-questions/' },
  l1a: {
    label: 'USCIS L-1A and L-1B',
    url: 'https://www.uscis.gov/working-in-the-united-states/temporary-workers/l-1a-intracompany-transferee-executive-or-manager',
  },
  i751: { label: 'USCIS I-751', url: 'https://www.uscis.gov/i-751' },
  n400: { label: 'USCIS N-400', url: 'https://www.uscis.gov/n-400' },
  i94: { label: 'Your I-94 record' },
  ds2019: { label: 'Your DS-2019' },
  approval: { label: 'Your approval notice' },
};

export const PACKS = {
  base: {
    label: 'Base',
    rules: [
      {
        id: 'address_change',
        name: 'Address change due',
        kind: 'date',
        anchor: 'moved_on',
        offsetDays: 10,
        requires: ['moved_on'],
        unless: 'address_reported',
        floor: 'act',
        reason: 'You moved on {moved_on}. Report your new address to USCIS within 10 days. You file it yourself.',
        link: { label: 'Change your address at USCIS', url: 'https://www.uscis.gov/ar-11' },
        source: SRC.ar11,
      },
      {
        id: 'passport_expiry',
        name: 'Passport expires',
        kind: 'date',
        anchor: 'passport_end',
        requires: ['passport_end'],
        reason: 'Needs six months left when you re-enter the US.',
        source: SRC.travel,
      },
      {
        id: 'i94_expiry',
        name: 'I-94 expires',
        kind: 'date',
        anchor: 'i94_end',
        requires: ['i94_end'],
        reason: 'The "admit until" date on your I-94 record.',
        source: SRC.i94,
      },
    ],
  },

  f1_opt: {
    label: 'F-1 / OPT',
    rules: [
      {
        id: 'work_permit_expiry',
        name: 'Work permit card expires',
        kind: 'date',
        anchor: 'ead_end',
        requires: ['ead_end'],
        reason: 'Your work authorization ends on this date unless an extension reaches USCIS first.',
        variants: [
          {
            when: 'stem_received',
            reason:
              'Your extension arrived in time, so you can keep working until {ead_end+180}. Your employer still has to re-check your papers by {ead_end}.',
          },
        ],
        source: SRC.i9Students,
      },
      {
        id: 'stem_pending_work_end',
        name: 'Last day of work if still pending',
        kind: 'date',
        anchor: 'ead_end',
        offsetDays: 180,
        requires: ['ead_end', 'stem_received'],
        unless: 'stem_approved',
        reason: '180 days after your card expires.',
        source: SRC.i9Students,
      },
      {
        id: 'unemployment_days',
        name: 'Unemployment days',
        kind: 'counter',
        usedField: 'unemployment_days_used',
        limit: 90,
        limitWhen: { field: 'stem_approved', limit: 150 },
        pausedField: 'employed',
        requires: ['unemployment_days_used'],
        reason: 'Not counting while you are employed. The limit rises to 150 if your extension is approved.',
        reasonRunning: 'Every day without a reported employer counts. Report a new employer as soon as you have one.',
        source: SRC.unemployment,
      },
    ],
  },

  h1b: {
    label: 'H-1B',
    rules: [
      {
        id: 'h1b_grace',
        name: 'Grace period ends',
        kind: 'date',
        anchor: 'employment_end',
        offsetDays: 60,
        capField: 'i94_end',
        requires: ['employment_end'],
        floor: 'watch',
        reason:
          'Day {elapsed} of 60. By {due} a new employer must file for you, you must file to change status, or you must leave.',
        source: SRC.termination,
      },
      {
        id: 'six_year_limit',
        name: 'Six-year limit',
        kind: 'date',
        anchor: 'h1b_start',
        offsetYears: 6,
        offsetDays: -1,
        requires: ['h1b_start'],
        reason: 'Counted from {h1b_start}.',
        source: SRC.h1b,
      },
    ],
  },

  j1: {
    label: 'J-1',
    rules: [
      {
        id: 'j1_program_end',
        name: 'Program ends',
        kind: 'date',
        anchor: 'program_end',
        requires: ['program_end'],
        reason: 'The end date on your DS-2019.',
        source: SRC.ds2019,
      },
      {
        id: 'j1_grace',
        name: 'Grace period ends',
        kind: 'date',
        anchor: 'program_end',
        offsetDays: 30,
        requires: ['program_end'],
        reason: 'You have 30 days to depart after your program ends on {program_end}.',
        source: SRC.j1,
      },
    ],
  },

  o1_l1: {
    label: 'O-1 / L-1',
    rules: [
      {
        id: 'worker_grace',
        name: 'Grace period ends',
        kind: 'date',
        anchor: 'employment_end',
        offsetDays: 60,
        capField: 'i94_end',
        requires: ['employment_end'],
        floor: 'watch',
        reason: 'Day {elapsed} of 60 after your job ended. The grace period stops early if your I-94 expires first.',
        source: SRC.termination,
      },
      {
        id: 'status_end',
        name: 'Authorized stay ends',
        kind: 'date',
        anchor: 'status_end',
        requires: ['status_end'],
        reason: 'The end date on your approval notice.',
        source: SRC.approval,
      },
      {
        id: 'l1_limit',
        name: 'L-1 time limit',
        kind: 'date',
        anchor: 'l1_limit_end',
        requires: ['l1_limit_end'],
        reason: 'Seven years in total on L-1A, five on L-1B.',
        source: SRC.l1a,
      },
    ],
  },

  green_card: {
    label: 'Green card path',
    rules: [
      {
        id: 'i751_window_opens',
        name: 'Window to remove conditions opens',
        kind: 'date',
        anchor: 'conditional_end',
        offsetDays: -90,
        requires: ['conditional_end'],
        reason: 'File Form I-751 in the 90 days before {conditional_end}.',
        source: SRC.i751,
      },
      {
        id: 'conditional_end',
        name: 'Conditional residence expires',
        kind: 'date',
        anchor: 'conditional_end',
        requires: ['conditional_end'],
        reason: 'Form I-751 must be filed before this date.',
        source: SRC.i751,
      },
      {
        id: 'n400_early',
        name: 'Earliest day to file for naturalization',
        kind: 'date',
        anchor: 'residence_complete',
        offsetDays: -90,
        requires: ['residence_complete'],
        reason: 'Form N-400 can be filed 90 days before {residence_complete}.',
        source: SRC.n400,
      },
    ],
  },
};

// Who the student is, beyond their dates. None of it changes a deadline; it
// tells the Bots which school office to write to and what news to look for.
export const DEGREES = ["Bachelor's", "Master's", 'Doctorate', 'Other'];
export const ABOUT_FIELDS = [
  { id: 'school', label: 'School', hint: 'The school on your I-20 or DS-2019.', max: 100 },
  { id: 'degree', label: 'Degree', options: DEGREES },
  { id: 'major', label: 'Major or field of study', hint: 'As your school lists it.', max: 100 },
  { id: 'home_country', label: 'Home country', hint: 'Where you applied from, and whose passport you hold.', max: 60 },
];

export const VISA_TYPES = {
  f1_opt: { label: 'F-1 on OPT', packs: ['base', 'f1_opt'] },
  h1b: { label: 'H-1B', packs: ['base', 'h1b'] },
  j1: { label: 'J-1', packs: ['base', 'j1'] },
  o1_l1: { label: 'O-1 or L-1', packs: ['base', 'o1_l1'] },
  green_card: { label: 'Green card path', packs: ['base', 'green_card'] },
};

// Labels for profile fields, used on the Settings page.
export const FIELD_LABELS = {
  ead_start: 'Work permit valid from',
  ead_end: 'Work permit card expires',
  stem_received: 'STEM extension received by USCIS',
  employed_since: 'Employed since',
  unemployment_days_used: 'Unemployment days used',
  passport_end: 'Passport expires',
  h1b_start: 'H-1B since',
  i94_end: 'I-94 valid to',
  employment_end: 'Last day of work',
  moved_on: 'Moved on',
  program_end: 'Program ends',
  status_end: 'Authorized stay ends',
  l1_limit_end: 'L-1 limit reached',
  conditional_end: 'Conditional residence expires',
  residence_complete: 'Residence requirement complete',
};

// What the setup form asks for, pack by pack. `type` is 'date', 'number' or
// 'flag'. Every field is optional: a rule only applies once its dates are in.
// `where` tells the person which document the answer is on.
export const PACK_FIELDS = {
  base: [
    { id: 'passport_end', type: 'date', label: 'Passport expires', where: 'On the photo page of your passport.' },
    { id: 'i94_end', type: 'date', label: 'I-94 valid to', where: 'The "admit until" date on your I-94 record. Leave empty if it says D/S.' },
    { id: 'moved_on', type: 'date', label: 'Date you last moved', where: 'Only if you moved in the last few weeks.' },
    { id: 'address_reported', type: 'flag', label: 'I already told USCIS my new address' },
  ],
  f1_opt: [
    { id: 'ead_start', type: 'date', label: 'Work permit valid from', where: 'The "valid from" date on your EAD card.' },
    { id: 'ead_end', type: 'date', label: 'Work permit card expires', where: 'The "card expires" date on your EAD card.' },
    { id: 'stem_received', type: 'date', label: 'STEM extension received by USCIS', where: 'The received date on your I-797 receipt, if you filed.' },
    { id: 'stem_approved', type: 'flag', label: 'My STEM extension is approved' },
    { id: 'unemployment_days_used', type: 'number', max: 150, label: 'Unemployment days used', where: 'Your school official or the SEVP Portal has the count.' },
    { id: 'employed', type: 'flag', label: 'I have a job reported to my school right now' },
  ],
  h1b: [
    { id: 'h1b_start', type: 'date', label: 'H-1B since', where: 'The start date on your first H-1B approval notice.' },
    { id: 'employment_end', type: 'date', label: 'Last day of work', where: 'Only if your H-1B job has ended.' },
  ],
  j1: [{ id: 'program_end', type: 'date', label: 'Program ends', where: 'The end date in box 3 of your DS-2019.' }],
  o1_l1: [
    { id: 'status_end', type: 'date', label: 'Authorized stay ends', where: 'The end date on your approval notice.' },
    { id: 'employment_end', type: 'date', label: 'Last day of work', where: 'Only if your job has ended.' },
    { id: 'l1_limit_end', type: 'date', label: 'L-1 limit reached', where: 'L-1 only: seven years after you started on L-1A, five on L-1B.' },
  ],
  green_card: [
    { id: 'conditional_end', type: 'date', label: 'Conditional residence expires', where: 'On a two-year green card: the "card expires" date.' },
    { id: 'residence_complete', type: 'date', label: 'Residence requirement complete', where: 'Usually five years after you became a resident, three if married to a citizen.' },
  ],
};

// One line per visa type for the setup form: what Waypoint will watch.
export const VISA_BLURBS = {
  f1_opt: 'Work permit card, STEM extension, unemployment days.',
  h1b: 'The 60-day grace period after a job ends, the six-year limit.',
  j1: 'Program end date and the 30 days after it.',
  o1_l1: 'Authorized stay, the grace period, L-1 time limits.',
  green_card: 'Removing conditions, the earliest day to file for citizenship.',
};

export function fieldsFor(visaType) {
  const packs = VISA_TYPES[visaType]?.packs ?? ['base'];
  const own = packs.filter((id) => id !== 'base').flatMap((id) => PACK_FIELDS[id] ?? []);
  return [...own, ...PACK_FIELDS.base];
}
