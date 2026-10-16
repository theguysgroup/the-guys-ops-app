# GHL account scan (ai.pvmengine.com, read-only, 14/10)

## Workflows list page
- Top nav: "Automation" title, tabs "Workflows" | "Global Workflow Settings". Top-right "What's new" + "Automation updates" pill.
- Header "Workflows list"; buttons: "Create folder" (outline), "Build using AI" (purple outline, sparkle icon), "+ Create workflow" (solid blue).
- Sub-tabs: "All workflows" | "Needs review (0)" | "Deleted" | "+ New smart list"; right: "Customize list".
- Toolbar: "Advanced filters" pill; view toggles (clock icon = recent?, list icon); "Search" box.
- Breadcrumb "Home" (folder path).
- Table columns: checkbox | Name (with external-link icon to open in new tab) | Status (pill: "Draft" grey, "Published" green outline) | Total enrolled (blue link number) | Active enrolled (blue link) | Last updated | Created on | Stats (info icon; ">" chevron per row) | ⋮ row menu.
- Folders appear as rows with a folder icon (e.g. "DO NOT MODIFY" folder with lock icon).
- ACCIDENT: navigating to /v2/location/<loc>/automation/workflows created an empty draft "(Company) New Workflow : 1791960041551" at 17:40:41. Ofek told; not deleted by me.

## Global Workflow Settings
- "Notifications" card: toggle + "Email notification": "By default, Workflow error notifications are sent to all agency and location admin users via email, but you can add other email addresses to be notified here." + "Select users" + Save.
- "Auto save" toggle (ON here): "Automatically save changes while editing your draft workflow..."
- "Pause workflow": "Temporarily pause selected workflows, putting them in draft state during a specified time period." "When to pause workflow?" rows: Start Date and Time → End Date and Time | Select workflows | copy | delete; "Annually" checkbox; "+ Add date"; "Pause dates: 1/ 15"; notes "Maximum allowed difference between the start and end date is 15 days." "A workflow should not be part of two or more date ranges that are overlapping."
- "Workflow AI" card: "AI Builder" toggle — "Build and edit workflows with AI - describe what you want to automate and AI generates the workflow for you."

## Builder (workflow "Website chat - new lead → email + notify the office", Published)
- Top bar: "← Workflows list" | panel-toggle icon | centered workflow name + pencil (rename) | avatar (presence) | notes/changes icon | undo | redo | "Saved"/"Save" button (blue, disabled when saved).
- 2nd bar: left dropdown "Standard builder" (other builder modes); center tabs "Builder" | "Settings" | "Enrollment history" | "Execution logs"; right "Test workflow" (light-blue button) + "Draft [toggle] Publish".
- Left icon rail (8 icons): comment bubble, check-circle, pie chart, document, external link, search, clock-history, AI sparkle (purple).
- Canvas: light grey dotted/grid background, rounded panel; top-left keyboard-shortcuts button; top-right "+ Add" button.
- Trigger card (wider, white, rounded): green icon tile + "Customer Replied"; divider; filter summary lines ('Reply channel is "Live chat"', 'Message body contains none of "C…"'); footer: duplicate icon, trash icon, "Stats" link (bar-chart icon, blue).
- Next to it: dashed light-blue box "+ Add new trigger".
- Trigger outputs drawn as rounded elbow lines merging into one vertical line → small "+" circle → first action.
- Action node: white rounded rectangle ~150x44, coloured icon tile left (blue person icon for contact/update, purple clock for Wait, green bell for notifications/email), 2-line title, "⋯" menu right.
- "+" small grey circle on every connector between nodes; "END" grey pill at bottom.
- Bottom-left vertical control stack: hand (pan mode), "+", zoom % (64%), "−", fit-to-screen. Bottom-right minimap.
- Auto-fit on load.

## Workflow Settings tab
- "Workflow settings" / "Configure how this workflow runs, including its default options and behavior."
- Card "Contact": toggles "Allow re-entry" (long help + Learn more), "Allow multiple opportunities", "Stop on response" ("Ends workflow for a contact if the contact responds to a message that is sent from this workflow.").
- Card "Communication": "Timezone" dropdown ("Account timezone"; "Wait steps and Time window executions will proceed based on this timezone."), "Time window" toggle "Specific time" ("Restrict actions from being sent outside the window you define."), "Sender details": "Sender email" From name / From email (with merge-tag icon), "From number" dropdown, "Conversations": "Mark as read" toggle.

## Enrollment history tab (URL .../status)
- "Enrollment history" / "View a history of all the Contacts that have entered this workflow"
- Filters: date range (Start date → End date), "All events" dropdown, "Search contact", refresh button with dropdown (auto-refresh?).
- Columns: Record (avatar + contact name) | Enrollment reason (trigger name, e.g. "Customer Replied") | Date enrolled (AEDT +11:00) | Current action (step icon + name) | Current status (pill "Finished" green) | Next execution on (AEDT) ("Not available") | Actions: clock icon (→ execution logs for that contact) + path icon.

## Execution logs (URL .../logs?executionId=&contactId=)
- "Execution logs" / "View a history and details of all executions performed by this workflow"
- Contact header card: avatar letter, name + open-in-new-tab icon, "Execution history for <name>", button "See contact path" (light blue, path icon).
- Filters: date range (2026-09-15 → 2026-10-14 default 30 days), "All actions", "All statuses", search (contact), refresh.
- Breadcrumb: "Logs / <name> / Execution ID - 01M4F…" (blue).
- Table (newest first): Action (step icon + name; final row "Removed by - End Of Workflow") | Status pills ("Finished", "Executed", "Wait Finished") | Executed on (AEDT) | Actions: "View details" link + icons (clock, person, enter/exit).

## See contact path (URL .../execution?id=)
- Same canvas, read-only; the path the contact took is highlighted: green node borders + soft green halo, dashed green connectors, an "Entered" blue badge on the trigger that enrolled them.
- Top-left info: Contact ID, Contact Details, Execution ID, Enrollment date, "Workflow version when execution started: 8" (workflows are versioned).
- "← Back" replaces "Workflows list" in the top-left.

## Add trigger picker (click "+ Add new trigger" box)
- A placeholder pill "● New Trigger" (light blue) appears on canvas next to existing trigger while picking.
- Right side panel (≈540px): header "Add trigger" + expand icon (→ centered modal ~960px) + X. Grid/category icon button + "Search triggers" input (autofocus). Tabs: "Triggers" (tools icon) | "Apps" (box icon).
- Body = collapsible bordered cards per category, chevron on the right of the header; each item = 32px outlined icon tile (category colour) + name + ">" chevron; hover shows grey bg + pin icon (pin favourites). Premium items show a small crown badge. Unavailable items greyed out (e.g. "Conversation AI trigger", "Custom trigger", "Event checked in").
- Categories & items as seen in THIS account (order as shown):
  - Recent triggers: Customer replied, Inbound webhook (crown)
  - Contact (blue icons): Birthday reminder, Contact changed, Contact created, Contact DND, Contact tag, Custom date reminder, Note added, Note changed, Task added, Task reminder, Contact engagement score, Task completed
  - Events (green icons): Inbound webhook (crown), Scheduler, Call details, Email events, Customer replied, Inbound email, Conversation AI trigger (greyed), Custom trigger (greyed), Form submitted, Survey submitted, Trigger link clicked, Facebook lead form submitted, TikTok form submitted, Video tracking, (one item not captured), Messaging error - SMS, LinkedIn lead form submitted, Funnel/website pageview, Quiz submitted, Prospect generated, Click to WhatsApp ads, External tracking event, User replied, AI studio form submitted, New review received, Video testimonial received
  - Appointments: Appointment status, Customer booked appointment, Service booking, Rental booking
  - Opportunities: Opportunity status changed, Opportunity created, Opportunity changed, Pipeline stage changed, Stale opportunities
  - Affiliate: Affiliate created, New affiliate sales, Affiliate enrolled in campaign, Lead created
  - Courses: Category started/completed, Lesson started/completed, New signup, Offer access granted/removed, Product access granted/removed, Product started/completed
  - Payments: Invoice, Payment received, Order form submission, Order submitted, Documents & contracts, Estimates, Subscription, Refund, Coupon code applied, Coupon redemption limit reached, Coupon code expired, Coupon code redeemed
  - Ecommerce stores: Shopify abandoned cart (deprecating soon), Shopify order placed, Shopify order fulfilled (deprecating soon), Order fulfilled, Product review submitted, Abandoned checkout, Add products to cart, Product viewed
  - IVR: Start IVR trigger
  - Facebook/Instagram events: Facebook - Comment(s) on a post, Instagram - Comment(s) on a post
  - Communities: Private channel access revoked/granted, Group access revoked/granted, Community group member leaderboard level c…, Group joining request rejected, Member registered for group event, Group comment created, Group post created, Requested to join group
  - Certificates: Badges issued, Certificates issued
  - Google ads: Google lead form submitted
  - Communication: TikTok - comment(s) on a video, Transcript generated, Conversations SLA
  - Client portal: Client portal file uploaded, User login (cp/memberships)
  - Events management (greyed): Event checked in, Event registration
- "Apps" tab of the picker: "Installed" list (Airtable, Apify, Asana, Basecamp, Browse AI… each row logo + name + verified tick + expand chevron) and "Discover" section = marketplace integrations whose triggers appear inside.

## Step editor (click a node) — opened as centered modal here because the expand state stuck; normally a right drawer
- Header: ^ / v arrows (jump to previous/next step), "Learn more" (lightbulb, light blue pill), collapse/expand icon, X.
- Icon tile + title + one-line description, e.g. "Customer replied — Runs when a customer replies to the selected type of communication."; "Wait — Holds a contact for a specific time, until a condition exists, or until the contact replies".
- Trigger editor fields: "CHOOSE A WORKFLOW TRIGGER" (dropdown, can switch type), "WORKFLOW TRIGGER NAME" (text), "FILTERS": rows of [field dropdown] [operator dropdown] [value / multi-value chips] [trash]; "⊕ Add filters" link. Footer: "Delete" (red outline, left), "Cancel", "Save trigger" (blue).
- Action editor (Wait): "Action name" text; "Selected wait type" card (icon + "For a set period of time" + "Change type" link); "Time period" number with − / + steppers and a ⋮ button (custom value); "Unit" dropdown (minutes…) + ⋮; "Advance window" toggle. Footer "Delete" | "Cancel" | "Save action" (disabled until something changes).
- "Change type" → "How do you want to wait?" + "✦ Set up with AI" (purple) and big option cards (icon, title, "Ex:" line, >):
  1. For a set period of time — Ex: 2 days, 6 hours, 30 minutes
  2. Until a specific date/time — Ex: December 4th at 9:00 AM
  3. Until a recurring window opens [New] — Ex: Every Tuesday, 15th of each month
  4. Until a scheduled date/time — Ex: 1 hour before scheduled appointment
  5. Until the contact replies — Wait for a reply on SMS, Email, etc.
  6. Until a user replies — Wait for a user to send a message to the contact
  7. Until the contact takes a specific action — Ex: Clicks a link, Opens an email
  8. Until specific conditions are met — Build a custom segment with any of your fields

## Actions picker (click "+" on a connector) — same layout as trigger picker: "Actions" header, "Search actions", tabs "Actions" | "Apps"
- Icon colour by category: Contact = blue, Communication = green, Internal/logic = purple, Payments/Opportunity/Appointments = blue, Google Sheets = green sheet icon; premium crown badges; "BETA" purple pill; greyed = unavailable.
- Recent actions: Send SMS, If / else, Update contact field, Wait, Send email
- Contact: Create contact, Find contact, Update contact field, Add contact tag, Remove contact tag, Assign to user, Remove assigned user, Enable/disable DND, Add to notes, Copy contact (crown), Edit conversation, Add task, Delete contact, Modify contact engagement score, Add contact followers, Remove contact followers, Merge contact, Email verification
- Custom objects: Create / Update / Clear fields of Associated Record for Contact
- Communication: Send email, Send SMS, Call, Voicemail, Messenger, Instagram DM, Manual action to SMS, Manual action to call, GMB messaging (grey), Send internal notification, Send review request, Conversation AI, Facebook interactive messenger, Instagram interactive messenger, Reply in comments (grey), Whatsapp: customer service window check, Whatsapp: send flows, Send live chat message, Appointment booking conversation AI bot, Update conversation AI bot and status, Book appointment, Log external call, WhatsApp, WhatsApp media, WhatsApp interactive messages, TikTok interactive messenger, Send opt-in message (BETA), RCS interactive message (BETA), Send RCS (BETA), Add internal comments
- Slack: Send Message (crown)
- Send data: Webhook, Custom webhook (crown)
- Google Sheets (all crown): Create spreadsheet row, Create multiple…, Lookup spreadsheet row, Lookup multiple…, Update specific…, Update multiple…, Update … using lookup, Clear specific…, Clear … using lookup, Format…, Remove spreadsheet row(s)
- Internal (purple): If / else, Wait, Goal event, Split, Update custom value, Go to, Date/time formatter, Number formatter, Math operation, Set event start date, Add to workflow, Remove from workflow, Array formatter, Drip, Text formatter, Custom code (crown)
- Workflow AI: AI Agent (crown)
- External AI models: GPT powered by OpenAI (crown), AI image generation (crown)
- Eliza: Eliza AI appointment booking, Send to Eliza agent platform
- Appointments: Update appointment status, Create appointment / booking note, Generate one time booking link
- Opportunity: Create/update opportunity, Remove opportunity, Add owner to opportunity, Remove owner from opportunity, Add follower(s) to opportunity, Remove follower(s) from opportunity, Find opportunity, Create opportunity, Update opportunity, + 5 BETA associated-record actions (grey)
- Payments: Stripe one time charge, Send invoice, Send estimate, Send documents & contracts, Send recurring invoice, Update inventory
- Marketing: Add to Google Analytics, Add to Google Ads, Facebook - Add to custom audience, Facebook - Remove from custom audience, Meta conversion API, Generate marketing audit report
- Affiliate (6), Membership (4 course actions), IVR (greyed: Gather input on call, SAY OR PLAY MESSAGE, Connect to call, End call, Record voicemail), Certificates (Issue certificate, Issue badge)
- Agent Studio: Invoke flow agents, Invoke managed agents
- AI Actions (crown): AI translate, AI summarize, AI intent detection, AI decision maker, AI extract data (BETA), AI analyze image, AI email parser (BETA)
- Associations: Remove associated records from workflow, Add associated records to workflow, Associate records with Contact (BETA)
- Communities: Smart push notification, Grant group access, … Grant community group leaderboard points
- Company: Create and associate company, Update associated company, Clear associated company fields
- Conversation AI (greyed): AI capture information, Book appointment, End conversation, Custom message, Transfer bot, Continue conversation, Services booking
- Events Management (BETA): Register for ticketed event, Register for rsvp event
- Voice AI: Voice AI outbound call (BETA)

## Node hover / menu
- Hover: node border turns blue, a ⋮⋮ drag handle appears on the left edge, two small icon buttons float above the top-right corner (pause-step and comment).
- "⋯" menu: Copy action / Copy all actions from here | Move action / Move all actions from here | Delete action / Delete all actions from here | Notes.

## Builder mode dropdown (top-left): "Standard builder" ✓ | "Advanced builder"
## Canvas "+ Add" (top-right) menu: "Add trigger" / "Add action"

## Left tool rail (tooltips + shortcuts)
1. Notes (⇧C)  2. Errors check — tooltip "No errors found. All good." (⌘⇧E)  3. Stats view (⌘⇧S)  4. Sticky notes (⇧S)
5. Workflow Switcher (⇧W)  6. Find and Replace (⌥F)  7. Version history (⇧V)  8. Workflow AI (⇧A, purple sparkle)
- Version history: left panel "Version history — Version history is kept for 30 days, or the last 10 versions if older." filter + X; "Current version" card (name, v8, Restore, ⋮, avatar+date, "Published" pill), "Previous versions" list v7…v1; canvas shows a yellow banner "This Version is in View Only Mode"; only Builder/Settings tabs visible.
- Stats view: banner "Workflow is not editable in Stats view. Note: Stats are only available for the last 30 days." Trigger card shows 3 numbers: Attempted / Matched / Unmatched (277 / 44 / 233 here); action nodes widen.
- Workflow AI: left drawer with toggle "Build" | "Chat"; purple sparkle tile; "What would you like to change?"; textarea "Describe changes to your workflow..." + mic + send; quick cards "Edit this workflow — Tell AI what to modify", "Describe this workflow — Walk through what this workflow does".
- "Test workflow" → modal "Run a test": "Select contacts" (Select contact) + "Run test".
- After the whole scan the top-right still showed "Saved" (disabled), undo disabled, Publish on → nothing changed. Tab closed.
