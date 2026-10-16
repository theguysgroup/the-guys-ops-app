# GoHighLevel (HighLevel / LeadConnector) — Automation → Workflows: public-source UX inventory (2025–2026)

Compiled 14 Oct 2026 from public sources only (no login). Primary source: the HighLevel Support Portal (help.gohighlevel.com, ~240 workflow articles crawled, most "Modified on" dates between mid-2025 and Oct 2026), plus ~40 screenshots/GIF frames from those articles that I opened and looked at, plus YouTube transcripts (official HighLevel channel and two tutorial creators).

**Legend**
- **[C]** = certain: seen verbatim in a help article, in a screenshot I opened, or in a transcript.
- **[I]** = inferred: my reading of a screenshot without a label, an extrapolation, or conflicting/old sources.
- Labels in "quotes" are exact on-screen text. HighLevel changed casing in mid-2026 (e.g., "Enrollment History" → "Enrollment history", "Test Workflow" → "Test workflow", "Add New Trigger" → "Add new trigger"). Both versions appear below; the newer one is sentence case.

**Important context [C]:** two builders exist side by side.
- **Standard Builder**: vertical, top-to-bottom list-like canvas.
- **Advanced Builder**: freeform, horizontal node canvas with multiple entry points, delinked branches, and trigger "Go-To" links.

The builder is chosen per workflow with a dropdown at the top-left of the builder ("Standard Builder" / "Advanced Builder"). A default is set in Global Workflow Settings.

---

## 0. Where it lives (navigation) [C]

- Left app sidebar item: **"Automation"** (play-in-circle icon).
- The top tab bar inside Automation changed over time:
  - **2024–25:** "Workflows", "Content AI", "Campaign", "Triggers" (legacy), then a vertical divider, then a cog icon with "Global Workflow Settings".
  - **2026:** "Workflows", "Overview" (with a small yellow "Beta" badge), then a divider, then "Global Workflow Settings".
- Top-right of the Automation area: a "What's New" / "Automation Updates" pill.
- **"Overview"** opens the Automations Overview dashboard [C]:
  - Totals: total workflows, published workflows, total enrollments.
  - "Workflow Enrollments Over Time" (weekly).
  - "Trigger Analysis Filter" (by trigger type, form or survey; last 30 days).
  - "Error Review Summary" with a "Needs Review" link.
  - Custom date range; data shown in the account timezone.

Sources: https://help.gohighlevel.com/support/solutions/articles/155000006813-automation-overview ; screenshots in 155041003123, 155066282177, 155039915452

---

## 1. Workflows list page

### 1.1 Header and buttons [C]

- Page title: "Workflow List" (2024–25), then "Workflows list" (2026).
- Empty or first-time state, 2026 landing page: title "Workflows", subtitle "Automate your processes using simple triggers and actions." (details in §1.6).
- Top-right buttons, left to right:
  - **"Create Folder"**: white, bordered, folder icon.
  - **"Build using AI"** (2026): white, purple border and purple text, sparkle icon.
  - **"+ Create Workflow"**: solid blue primary. It opens a dropdown.
- "Create Workflow" dropdown items by version:
  - **2024:** "Select a Recipe", "Start from Scratch", "Select from Template", "Surfboards based workflow ( Beta )".
  - **Late 2025:** "Start from Scratch", "Select from Template", "Company based workflow ( Beta )".
  - **2026:** "Start from Scratch", "Build Using AI", "Select from Template", "Import from a campaign", "Company based workflow".
  - Each item has an icon: + / sparkle / template / upload / building.

### 1.2 Tabs row (under the title) [C]

- "All Workflows" (active, blue underline).
- "Needs Review (N)": workflows with errors.
- "Deleted": restore bin.
- Any saved Smart Lists appear as extra tabs.
- A divider, then "+ Smart List" ("+ New Smart List" in 2026).
- Far right: "Customize List" (sliders icon). It edits or deletes the current smart list.

### 1.3 Toolbar row [C]

- Left: **"Advanced Filters"** (funnel icon, pill button). It opens a right-side panel.
- Right: three square icon buttons, then a **"Search"** input with a magnifier.
  - The icons are a clock with circular arrow, a clock, and a bulleted list.
  - [I] They are probably "recently viewed / recent / list view" toggles. They carry no labels in any source.
- Below the toolbar is a breadcrumb: "Home", or "Back / <Folder name>" when inside a folder.

### 1.4 Table [C]

Columns (2024–2026): checkbox (2025+), then:
- "Name"
- "Status"
- "Total Enrolled"
- "Active Enrolled"
- "Last Updated"
- "Created On"
- "Stats ⓘ"
- kebab menu (⋮)

Cell details:
- **Folder rows**: folder outline icon plus name; enrolled counts are blank.
- **Status** is a pill:
  - "Published": green text, light green fill, green border.
  - "Draft": grey text, white or grey fill, grey border.
  - "Paused": shown when a workflow is inside a Global "Pause Workflow" date range.
- **Total / Active Enrolled** are blue clickable numbers [I: they link to Enrollment History].
- **Dates** look like "Feb 02 2023, 7:36 PM" (2026: "Mar 16 2026, 12:54 AM").
- **Stats** has a chevron ">" that expands the row inline (accordion):
  - Tabs: "Email" and "SMS".
  - Email metrics: "Delivered", "Opened", "Clicked", "Replied", "Bounced", each as a big percentage (Delivered blue, Opened green, Clicked purple, Replied black, Bounced red).
  - Stats data starts 1 Jan 2023; deleted actions' stats are kept; no folder-level stats.

Pagination (2026): "Previous", page numbers "1 2 3 … 23", "Next", and a "10 / page" size dropdown.

### 1.5 Row kebab menu (⋮) on a workflow [C, screenshot 2025]

- "Upload to Template Library"
- "Edit Workflow"
- "Rename workflow"
- "Open in New Tab"
- "Draft Workflow" or "Publish" (toggles status)
- "Move to Folder"
- "Duplicate Workflow"
- "Copy To Sub-Account"
- "Delete Workflow"

Behaviours:
- **Deleting** a workflow requires typing the workflow name. It goes to the "Deleted" tab for 30 days.
  - Admins can "Restore" from there; the workflow comes back as Draft at the root level, without its folder permissions.
  - A deleted workflow can only be restored after 30 minutes.
  - A restored workflow cannot be deleted again for 48 hours.
- **Folder rows** use "Rename Folder", "Delete Folder", "Move To Folder", and "Manage Permissions" (via the folder's actions menu).
  - Deleting a folder does not delete its contents; they move up one level.
- **"Move to Folder" modal**: browse into the target folder, then "Move Here". A "New Folder" button is also there.
- **Nested folders** are supported. Create Folder inside a folder creates a subfolder.
- **Folder Permission** (Agency Pro and above) options: "Agency Admin", "Agency User", "Account Admin", "All".

### 1.6 Create flows [C]

- **Start from Scratch**: opens the empty builder named "New Workflow : <13-digit timestamp>", for example "New Workflow : 1737001485504".
- **Templates / Recipes**:
  - A library with filters and search, "Preview", then "Choose template".
  - Landing-page cards seen: "Email Drip Sequence", "Appointment Confirmation + …", "Fast 5 Lite".
  - A recipe seen in screenshots: "Recipe - Fast Five", "Recipe: IVR".
  - Niche-tailored templates (Education, Health, Finance, Real Estate) and a "View All Templates" link.
- **2026 landing page (AI Builder enabled via Labs)**:
  - Centred prompt "What do you want to automate?" with a "BETA" superscript.
  - Subtitle "Build workflows for free by chatting with AI".
  - A large textarea with a mic (voice dictation) button and a round purple send-arrow button.
  - Suggestion chips: "Lead Nurturing", "Form Automation", "Email Campaigns", "more".
  - Then an "Or" divider, "Start with a Template" cards, and a "Learn About Workflows" video section.
  - First-time users pick a business niche.
- **Build using AI**: a modal with a prompt; it generates the workflow and opens the builder (see §9).

### 1.7 Bulk actions [C]

- Row checkboxes, plus a header "Select All" with a dropdown: "All Workflows", "All Folders", "Published Workflows", "Draft Workflows".
- The bulk toolbar offers:
  - "Publish/Draft" (workflows only)
  - "Move" (workflows or folders)
  - "Delete"
  - "Manage Permissions" (folders only)
- A confirmation dialog shows the count and any warnings.
- Video narration also mentions "publish all" and "draft all".

### 1.8 Advanced Filters and Smart Lists [C]

- The right panel filters by Triggers, Actions, Tags, Status (Published / Draft / Paused), last updated, and modified by.
- Operators: "equals", "contains", "does not contain".
- "+ And Condition" / "Or Condition", "+ Add Filter Condition", trash icon per row, "Apply".
- After applying: "Save", then "Save as New Smart List" or "Discard Changes".
- A saved Smart List becomes a tab; edit it with "Customize List".

### 1.9 Global Workflow Settings page (Automation → "Global Workflow Settings") [C]

- **Default builder**: "Default builder for new workflows": Standard Builder or Advanced Builder.
- **Switch permission**: "Who can switch between builders" (checkboxes: Sub-account admins, Sub-account users; agency users always allowed).
- **Auto Save** toggle.
- **Workflow AI**: an AI Builder toggle per location.
- **Error notification emails** (introduced as "Workflow Settings"):
  - Toggle on/off (default off) and a recipient list.
  - At most one email per 24 h, with a "Review it" button linking to Needs Review.
- **"Pause Workflow"**: rows of a date range ("Start Date and Time" → End, then "Confirm"), "Select Workflows" (published only), and an "Annually" checkbox.
  - Clone and delete icons per row; "Add Date" adds a row; up to 15 rows.
  - Maximum 15 days per range; no overlapping ranges.
  - Enrolment continues during a pause, but contacts hold at the first non-Wait / non-If/Else step.
  - Each workflow's Settings shows a "Pause Workflow" section.
- Visible only to agency admins and agency users.
- Agencies can also set the default per sub-account: Agency Settings → Workflow Settings → "Manage default builder per sub-account".

Sources:
- 155000003974 (filters), 155000001684 (nested folders), 155000007066 (bulk), 155000003972 (stats), 155000002639 (restore), 48001219648 (folder permission), 155000004871 (landing), 155000002288, 155000002445, 155000003065 (error notifications), 155000003850 (pause), 155000007323 (default builder) — all under https://help.gohighlevel.com/support/solutions/articles/<id>
- Screenshots: 155041003123, 155039915452, 155040685443, 155037824117, 155066282177; jumpshare 2026-05-11 list screenshot inside 155000002470.
- Video: GHL Wizard "GoHighLevel Workflows Tutorial 2026" https://www.youtube.com/watch?v=pgKCulPwEqg

---

## 2. The builder screen

### 2.1 Top bar

**2024–25 [C]** (screenshots Jan 2025):
- **Row 1**:
  - Left: "< Back to Workflows".
  - Centre: the workflow name (bold, ~20px) with a pencil icon for inline rename. Long names truncate with "…" and show a tooltip on hover.
  - Right: a version-history icon (clock with arrow), then the Save button.
    - With unsaved changes: solid blue "Save" with a small red dot badge.
    - Otherwise: light blue, disabled "Saved".
- **Row 2**:
  - Centre tabs: "Builder", "Settings", "Enrollment History", "Execution Logs". The active tab is blue with a 2px blue underline.
  - Right: "Test Workflow" (light-blue tinted button, blue text), then the label "Draft", a toggle, and the label "Publish". The toggle is blue/right when published, grey/left when draft.

**2026 [C]** (screenshots May–Jul 2026):
- **Row 1**:
  - Left: "← Workflows list", then a square panel-toggle icon (collapse sidebar).
  - Centre: the name with a pencil.
  - Right: user avatar circle(s) for presence (e.g., "SN"), "Recent changes" (document-with-clock icon), Undo (↶), Redo (↷), then Save.
  - Save states: "Save" blue with red dot; "Saved" disabled light blue; with Auto Save on, a cloud icon plus "Saved".
- **Row 2**:
  - Left: "Reload Child App" (only in some contexts), then the builder dropdown "Standard Builder ▾" / "Advanced builder ▾".
  - Centre: tabs "Builder | Settings | Enrollment history | Execution logs".
  - Right: "Test workflow", then "Draft [toggle] Publish".
- **Save toast** (top-right): green check, "Saved!", "Workflow has been saved.", and a close ×.
- **Publish gate (Sep 2026)**: Publish runs validation. If issues exist, a modal "Workflow can't be published yet" appears with "Review issues", which opens the "Resolve Errors" sidebar. Each error offers "Open step" and "How to fix" (AI). Saving with errors is allowed; publishing is not.
- **Saved vs Published** are independent states: "Saved and Published are not the same thing".

### 2.2 Left vertical tool sidebar (Builder tab) [C]

- **Jan 2025**: a floating white rounded panel with Stats view (pie icon), divider, Notes (speech bubble), Sticky note (square note). A "Workflow AI" sparkle button sits bottom-left.
- **2026**: a full-height icon rail. Top to bottom, as narrated in the GHL Wizard 2026 walkthrough and seen in screenshots:
  1. Notes (speech bubble): workflow-level notes.
  2. Errors (check-circle): shows "No errors found" or the error list.
  3. "Stats view" (pie chart).
  4. Sticky notes (page/note icon).
  5. Workflow Switcher (square-with-arrow icon; shortcut Shift+W).
  6. Find (magnifier): Find & Replace, Alt/Option+F.
  7. Version History (clock with arrow).
  8. Workflow AI (purple sparkle).
  - Bottom: a dark-mode toggle (crescent moon) [C: icon seen; I: function].
- **Sidebars are resizable** (drag the inner edge). Any action or trigger panel can expand to full screen.

### 2.3 Canvas, Standard Builder [C]

- An infinite canvas, light grey (#F4F5F7-ish [I]).
  - 2024–25: a dotted background.
  - 2026: a faint square grid.
- **Flow is vertical, top to bottom:**
  - Trigger cards sit side by side in a row at the top, with an "Add New Trigger" placeholder card always at the end of the row.
  - Connector lines from every trigger drop down and merge with rounded elbows into a single trunk.
  - A "+" sits on every segment of the line.
  - Actions stack vertically below.
  - The flow ends at an "END" pill.
- **Empty workflow**: only the "Add New Trigger" card, a line with "+", then "END".
- **Add actions**: click "+" on a line. The tooltip text over a "+" is "Please select action".
  - In 2026 you can also drag an item from the Actions panel onto a "+" or between steps. A highlighted placeholder pill shows the drop slot (e.g., "• Wait").
  - A top-right canvas button "+ Add" opens the Triggers & Actions panel.
- **Move nodes**: hover a node to reveal a 6-dot drag handle, drag it, and drop it where "Move here" is indicated. The older way was the node menu "Move" (§2.6).
- **Bottom-left controls** (vertical stack):
  - 2026: Hand/pan tool, "+", zoom % (e.g., "100%", "103%", "111%", "144%"), "−", and Fit to screen (four-corner arrows).
  - 2025: "+", "100%", "−", fit.
- **Bottom-right**: a minimap (white card with a viewport rectangle).
- **Top-left of canvas**: a Keyboard Shortcuts button (keyboard icon, or press K).
- **Bottom-left (2025)**: an AI "Suggestion" chip plus "Add actions →" next to the round purple Workflow AI button.
- **No visual loops**: arrows cannot go back up. Loops are only possible via the "Go To" action.
- Hover a node to reveal an Enable/Disable (pause/play) control. A disabled node is greyed out with a "Disabled" tag and is skipped at runtime. This works in both builders since 2026.

### 2.4 Canvas, Advanced Builder [C]

- A freeform whiteboard. The default auto-layout is horizontal, left to right: triggers on the left, actions to the right.
- **Nodes are compact squares** (~72×72 px at 100% [I]) with rounded corners, a white fill and a soft shadow. They show only the icon; the label is centred **below** the tile.
  - Triggers have a connector dot on the right only.
  - Actions have dots on both left and right.
- **Edges**:
  - Solid grey lines with an arrowhead into the target's left dot are normal sequential links.
  - A dashed grey line with an arrowhead is a **trigger Go-To** (the trigger starts at a specific action).
  - Each chain ends with a small "[+]" square button.
- **Connect** by dragging from a connector dot or the "+" to another node.
  - Delete an edge via a trash icon on the line.
  - Insert a step via "+" on the line.
  - Drag from the panel onto the last node to extend a branch, or onto an edge to insert.
- **Rules**:
  - 1:1 connections: each action has one next step and one incoming link; re-connecting overwrites.
  - Each trigger must connect to exactly one action. An unassigned trigger auto-connects to the Root action.
  - With multiple parallel branches you mark one "Default Path" via a branch icon on the branch's first node. It shows as "(Default Path)" under the node label. Tests and contacts added from other workflows follow it.
  - Single enrollment per contact: no concurrent runs across branches.
- **Delinked nodes**: independent clusters ("parallel workflows") placed anywhere. They only run if a trigger Go-To points at them.
- **"Tidy Up"** auto-layout ("format tree") is at bottom-left; keyboard "2" also tidies, per the video.
- **Bottom toolbar (2026)**: select (arrow), fit, zoom-out, zoom-in, tidy/layout.
- **Sticky Notes 2.0**: colored rectangles that can sit behind node groups, with a bold title and a rich-text editor (bold, italic, underline, font size, bullets, links, images). They can be duplicated, recoloured, resized, and shown or hidden.
- **Workflow Comments** (inline): named in the docs as part of the Advanced Builder UX upgrade; no detail published [I].
- **Right-click Quick Actions menu**: named in the docs; items not published [I].
- **Bulk selection**: marquee or Shift-drag. Context actions include "Enable/Disable", "Format Selection", and "Add Sticky Note". Copy and paste work across workflows.
- **Switching back to Standard** requires removing Advanced-only items (Trigger Go-To, Delinked nodes, Disabled nodes in older docs).
- The builder choice is saved per workflow. Draft/Published is independent of builder type.

### 2.5 Node look (Standard Builder) [C, screenshots]

**Trigger card, 2024–25**:
- A white card, ~330×95 px at 100% [I].
- A left icon tile (~44px rounded square, light-blue fill, blue outline icon).
- Two lines of text: "Trigger" (blue, medium) and the trigger name below (grey/dark, regular, e.g., "Contact Changed", "Customer Booked Appointment").

**Trigger card, 2026** (three sections separated by thin rules):
- **Header**: icon tile plus the trigger type in blue (e.g., "User replied"), with the user-given name under it (e.g., "Refund Tracker"). Some screenshots show just "Contact Created".
- **Body**: the "Trigger Narration", a plain-language filter summary.
  - Examples: "No filters applied", "Form is is any of "Culture Club ...", "Message body contains any of "ref…".
  - Long ones collapse with "+X more" and a "Details"/"View more >" link.
- **Footer**: copy (duplicate) icon, trash icon, and right-aligned "Stats" with a bar-chart icon in blue.
  - The trigger kebab offers "Copy" (creates "Copy of <name>") and "Delete" (with confirm).
- The selected trigger has a blue border.

**"Add New Trigger" placeholder card**:
- Same size as a trigger card, with a **dashed blue border** and a light-blue fill (#EEF4FF-ish [I]).
- Contains a blue "+" in a pale-blue rounded square and "Add New Trigger" in blue semibold.

**Action card**:
- A white card, ~290×70 px at 100% [I], rounded ~8px, a thin #E4E7EC-ish border [I], and a very soft shadow.
- Left: a ~36px rounded-square icon tile with a tinted background and a coloured glyph.
- Middle: the action name (user-editable; the default is the action type).
- Right: "···" (horizontal three dots).
- The selected action has a blue border.

**Category colours observed** (glyph colour on a tinted tile):

| Glyph colour | Actions |
|---|---|
| Dark green | Email (envelope), SMS (chat bubble), Call (phone), Internal Notification (bell) |
| Blue | Contact actions: user, tag (filled blue tag), Assign to user (person with check), Add Task (check-plus), Add Note (blue note), Copy Contact, Edit Conversation |
| Blue on light blue | Opportunity: "$" in a filled blue circle |
| Purple | Wait (filled purple circle with white clock hands); Remove from workflow (purple square with ×) |
| Blue braces "{ }" | If/Else (default node name "Condition"); IVR "Map Caller's input" |
| Slack logo | Slack actions (grey tile in logs) |
| Blue phone | IVR actions |

**If/Else on canvas**:
- The "Condition" node, then the line splits horizontally into branch-header cards.
- Each header card is white with a **3px purple bottom border**, a purple fork icon, a purple title ("Branch", or the user name; "None" for else), and a grey subtitle summary.
  - Example subtitles: If "Current Day of month" is "15"; for None, "When none of the conditions are met".
- Each branch gets its own "+" line and ends in its own "END".
- Older recipe screenshots show branch labels as grey pills ("Press 1", "Press 2", …, "None").

**Wait with reply/timeout**:
- Newer docs speak of a "timeout branch" that can be added or removed, implying two outgoing branches when Timeout is on.
- Exact branch labels were **not visible in any source** [I: probably a "replied/event happened" path and a "Timeout" path].
- In 2024 videos, creators instead followed the Wait with an If/Else "Contact replied = true".
- Conversation AI / Interactive Messenger actions create built-in branches named "Timeout" and "Default Timeout" [C].

**END node**: a small grey pill, light-grey fill, grey uppercase "END".

**"+" glyph**:
- 2024–25: a bare thin "+" centred on the line.
- 2026: a ~20px circle with a thin border and "+" inside.

### 2.6 Node kebab menu (Standard) [C, Aug 2025 screenshot]

- Clicking "···" opens a small popover titled "Actions" with a close ×. Items:
  - "Notes >"
  - "Copy >" with submenu "Copy Action" / "Copy All Actions From Here"
  - "Paste Below" (only when the clipboard has content)
  - "Move >"
  - "Delete >" [I: the submenu is probably "Delete Action" / "Delete All Actions From Here"; a video shows deleting all downstream actions]
- After copying, a toast at bottom-centre reads "Actions copied! Paste them into any workflow" with the subtext "Paste from any Action or Trigger ••• Menu".
- There is also a "Quick Paste" button next to "+".
- The clipboard lasts 15 minutes and works across tabs within the same sub-account.
- **Action-level notes** (formerly "comments"): a notes icon appears top-right on hover and stays visible once a note exists. Notes keep a history and are searchable from the main Notes panel.
- **Workflow-level notes** show Created by / Edited by / Created on / Edited on.

### 2.7 Right drawer (trigger/action configuration) [C]

- Opens from the right over the canvas, ~40% of the width and resizable. The canvas stays visible on the left.
- **2026 header**:
  - Up/down chevrons (previous/next step).
  - A blue "Learn more" chip with a light-bulb icon. It opens the Workflow AI Assistant on the left with context help ("Learn Mode").
  - Expand-to-full-screen (diagonal arrows) and close ×.
- **Identity block**: icon tile, step type title (e.g., "Wait"), and a one-line description.
  - Wait: "Holds a contact for a specific time, until a condition exists, or until the contact replies".
  - User replied: "Fires when a User replies to a contact or messages a contact."
- **Trigger drawer (2024–25)**:
  - Title "Workflow Trigger", subtitle "Adds a workflow trigger, and on execution, the contact gets added to the workflow".
  - Picker: a "Search Trigger" input, segmented tabs "All triggers" | "Discover", then category headings (e.g., "Contact") with list rows (outline blue icon plus name).
  - After picking, the fields are uppercase labels: "CHOOSE A WORKFLOW TRIGGER" (dropdown), "WORKFLOW TRIGGER NAME" (text), "FILTERS".
  - Each filter row: [field dropdown] [value or multiselect with chips, e.g., a "Main ×" blue chip] [trash icon]. Below the rows: a "⊕ Add filters" link.
- **Trigger drawer (2026)**:
  - "WORKFLOW TRIGGER NAME" and "FILTERS".
  - The filter field dropdown has an inline "Search" and grouped options: "Filter fields" (e.g., "Contact tags", "Has attachments", "Message body", "Message channel", "Replied By") and "Custom Fields (Enrolled Contact)".
  - Some triggers add a "Who should be enrolled into the workflow?" selector: "Contact only" / "Contact and Guests" / "Guests only" (appointment triggers).
  - Footer: "Delete" (red text, outlined), "Cancel" (outlined), "Save trigger" (solid blue).
- **Action picker drawer**:
  - 2024–25: title "Actions", subtitle "Pick an action for this step", input "Search Action". Category headings ("Contact", "Communication", …) and rows with a coloured icon plus name; premium items show a gold crown on the right.
  - 2026: title "Actions" (expand/close), a grid icon plus "Search For Actions" input, and tabs "Actions" | "Apps" (marketplace/integrations).
    - Collapsible sections, starting with "Recent Actions", then categories.
    - Rows have icon, name, badges ("BETA", crown for premium) and a ">" chevron.
  - The Discover/Apps area shows marketplace apps with "Top Installed", "Top Free", "Top Paid", "Newly Added", an "Update" tag, "Details", and an install CTA.
  - Search covers Built-in, Marketplace and AI; results show pricing, ratings and installs, and "Native"/"Beta" badges.
- **Action config body**:
  - "Action Name" (required text) at the top, then type-specific fields.
  - Most text fields have a tag icon (custom value / merge-field picker).
  - Number fields have − / + steppers and a "⋮" menu to switch "Standard" ↔ "Dynamic" value.
- **Footer (sticky)**: "Delete" (left, red), "Cancel", "Save Action" / "Save action" (blue).
- Edits inside the drawer are **not** auto-saved until Save action commits them to the canvas.
- **Integration steps** show locked fields until "Connect your account". There is an account selector. "Test Action" opens a "Test Drawer" with Status header, "Data In", "Data Out" and "Use this as sample"; side-effect actions confirm first with "Yes, Run Test" / "Cancel".
- **AI field tooltips** (ℹ️ hover plus "Explain Field") exist on some fields (Manual SMS, Manual Call).

### 2.8 Saving, auto-save, undo, versions [C]

- **Auto Save** (opt-in pop-up "Enable Auto Save Now" or a global toggle):
  - Saves canvas edits to the Draft continuously.
  - Captures add/delete steps, the Settings tab, rename and status.
  - Does not capture unsaved drawer edits.
  - With multiple editors, the last auto-save wins.
- **Undo/Redo** (toolbar arrows; ⌘/Ctrl+Z, ⌘/Ctrl+Y or ⌘+Shift+Z):
  - Per session; resets on refresh or restore; covers AI Builder edits.
  - "Recent Changes" list lets you jump to a point in the session.
- **Version History** (left-rail clock icon):
  - Sidebar title "Version History", subtitle "Version history is kept for 30 days, or the last 10 versions if older.", with a filter icon (filter by editor).
  - "Current Version" card: name, version chip (e.g., "v5"), blue "Save Version" link, ⋮ menu, editor avatar initial, timestamp (e.g., "Dec 16th, 10:05 pm"), and an amber "Auto-saved" pill.
  - "Previous Versions" cards: name, "v4…v1", a grey "Restore" link, ⋮, timestamp, and a grey "Draft" or "Published" pill.
  - Opening a version shows the canvas read-only with a yellow banner "👁 This Version is in View Only Mode". Tabs shrink to "Builder | Settings". The header shows "Version History".
  - Options: "Restore" (reopens as a new draft; the workflow must be Draft with no enrolled contacts) and "Create new workflow from version". A "Back to Builder" button returns to editing.
  - Versions are created on manual Save, on confirming the "Unsaved Changes" pop-up, on "Save Version", and on Draft↔Publish changes. Routine auto-saves do not create versions.
- **In-flight contacts**: contacts already in a workflow pick up edits to downstream steps, including newly added steps. A contact already waiting keeps its old Wait.

### 2.9 Keyboard shortcuts [C]

Open the overlay with "K" or the keyboard pill (top-left). Overlay tabs: "Essential", "Edit", "View", "Navigation", "Tools".

| Action | Shortcut |
|---|---|
| Cut selected node(s) | ⌘/Ctrl+X |
| Copy selected node(s) | ⌘/Ctrl+C |
| Paste node(s) | ⌘/Ctrl+V |
| Copy all actions from selected node onward | ⌘/Ctrl+Shift+C |
| Cut all actions from selected node onward | ⌘/Ctrl+Shift+X |
| Zoom in / out | + / − |
| Zoom to 100% | 0 |
| Fit view | 1 |
| Advanced: move to next/previous node | → / ← |
| Advanced: move to upper/lower sibling | ↑ / ↓ |
| Advanced: select upstream/downstream | Shift+← / Shift+→ |
| Standard: move to next/previous node | ↓ / ↑ |
| Standard: move to right/left sibling | → / ← |
| Standard: select upstream/downstream | Shift+↑ / Shift+↓ |
| Select all nodes | ⌘/Ctrl+A |
| Standard: select all actions | ⌘+Shift+A |
| Standard: select all triggers | ⌘+⌥+A |
| Delete selected node(s) | Del / Backspace |
| Delete all actions from selected node onward | ⌘/Ctrl+Del |
| Open Action panel | Tab |
| Open Trigger panel | Shift+Tab |
| Save workflow | ⌘/Ctrl+S |
| Workflow Switcher | Shift+W |
| Find | Alt/Option+F |
| Tidy (Advanced, per video) | 2 |

### 2.10 Other builder tools [C]

- **Workflow Switcher**: search, recent workflows, infinite scroll.
  - Originally opened in a new tab; since 2026 it switches in the same tab, with an "Open in new tab" option.
  - "+" creates a workflow; the options menu offers Duplicate and Delete.
- **Find & Replace**: modes "Custom values", "Tags", "Text".
  - Case-insensitive and partial match; Next/Previous navigation auto-pans to each match.
  - "Replace" / "Replace All" work for custom values and tags only.
  - Scope is the current workflow only.
- **Stats View**: a toggle (2025: "Stats View" switch at top-left of canvas; 2026: the pie icon in the rail, plus a yellow "Stats view" pill at top centre). The canvas is read-only while it is on.
  - Triggers show "Attempted / Matched / Unmatched" (last 30 days) and a "View Detailed Stats >" link.
  - That opens the modal "Stats: <trigger>":
    - Three KPI cards: Attempted, Matched with a % chip, Unmatched with a % chip.
    - Date range and a "Select Contact" filter.
    - Tabs "Stats Data" | "Top Reasons for Unmatch".
    - Table columns: "Name", "Email Address", "Date/Time", "Match Status" (Matched/Unmatched pills), "Reason for Unmatch". Example reason: "Filter not matched - Tag Added - Received value: [], Expected value: …".
    - Footer: "Data is stored for last 30 days" and "10 / page".
  - Communication actions show delivery and engagement stats (e.g., Delivered/Opened rates).
  - Split shows per-path counts.
  - Drip shows a stats view with batches.
- **Highlight Contact Path**: from Enrollment History or Execution logs ("See contact path"). Opens the builder with the contact's path highlighted, including error nodes, skipped nodes, entry/exit markers and in-progress state.

Sources:
- 155000001254 (Builder Walkthrough, Sep 2026), 155000006635 (Advanced Builder), 155000006700 (Delinked), 155000006690 (Trigger Go-To), 155000006654 (Auto Save), 155000006655 (Undo/Redo), 155000006656 (Version History), 155000006694 (Shortcuts), 155000006693 (Pause actions), 155000007729 (Find & Replace), 155000008326 (Sidebars), 155000003914 (Notes), 155000007764 & 155000006692 (Switcher), 155000006081 (Copy actions), 155000005370 (Copy/Delete triggers), 155000006636 (Trigger narration/stats), 155000004872 (Errors), 155000008032 (Test Action), 155000005631 (Learn more AI), 155000007460 (AI tooltips), 155000004025 (Discover) — all https://help.gohighlevel.com/support/solutions/articles/<id>
- Videos:
  - HighLevel official "How To Navigate HighLevel's Advanced Workflow Builder" https://www.youtube.com/watch?v=l2-t9CaxgFE (transcript read in full)
  - GHL Wizard 2026 https://www.youtube.com/watch?v=pgKCulPwEqg (transcript read in full)

---

## 3. Triggers (full list, grouped as in the picker)

The official list (article modified 19 Jun 2026) is below [C]. Category names are as headed in the article and picker. Each name is followed by its description.

**Contact**
- **Birthday Reminder**: on or around the birthday. Runs daily at 8 AM account time. Filters: "After Number of Days", "Before Number of Days", "Day Is", "Month Is".
- **Contact Changed**: filters on Custom Field, Tags, DND, etc.
- **Contact Created**: filters "Tag" (Equals to / Not equals to / Any of / None of; multiple Tag filters AND-ed) and Custom Fields.
- **Contact DND**: turned on or off.
- **Contact Tag**: filters "Tag Added" / "Tag Removed". It fires on both if no filter is set.
- **Custom Date Reminder**: before, on, or after a date field. Filters: Custom Date Field, "Match on Year Along with Day and Month", "After Number of Days", "Before Number of Days", "Has Tag", "Day Is", "Month Is".
- **Note Added**
- **Note Changed**
- **Task Added**
- **Task Reminder**: filters "Before no. of days" / "After no. of days" relative to the due date.
- **Task Completed**
- **Contact Engagement Score**

**Events**
- **Inbound Webhook** (premium): a unique URL per trigger that accepts POST/GET/PUT. You map the sample payload; it then has "Save Trigger".
- **Scheduler**: contactless and time-based.
  - Intervals: Custom (Nth weekday), Daily, Weekly, Monthly (day 1–31 or Last), Every N days, One-off date/time, Advanced (cron; at most hourly).
  - "Advanced Settings": "Skip Weekends", "Stop On".
  - "Check Trigger Schedule" previews the next 5 runs.
  - Contact-only actions are skipped.
- **Call Details**: filters "Call Direction" (Incoming/Outgoing), "Call Details/Status" (busy, canceled, voicemail, completed, no answer), "In Workflow", "In Phone Number". It appeared as "Call Status" in 2024.
- **Email Events**: Event filter (Clicked, Opened, Bounced, Unsubscribed, Complained (Spam)) and "In Workflow" filter.
- **Customer Replied**: filters
  - "Contains Phrase"
  - "Exact Match Phrase"
  - "Has Tag"
  - "Doesn't Have Tag"
  - "Intent Type" (e.g., positive, complaint, question)
  - "Replied to Workflow"
  - "Reply Channel". Selecting "All-in-One Chat" adds "Chat Type is" (Chat Widget / Live Chat), then "Chat Widget is" / "Live Chat is".
- **Conversation AI Trigger**
- **Custom Trigger**
- **Form Submitted**: filter "Form is" (multi-select) plus field filters and a T&C filter.
- **Survey Submitted**
- **Trigger Link Clicked**: filter on the trigger link.
- **Facebook Lead Form Submitted**
- **TikTok Form Submitted**
- **Video Tracking**: viewer reaches a chosen % of a video.
- **Number Validation**
- **Messaging Error – SMS**
- **LinkedIn Lead Form Submitted**
- **Funnel/Website PageView**: page/URL/UTM.
- **Quiz Submitted**
- **New Review Received**
- **Prospect Generated**
- **Click To WhatsApp Ads**
- **External Tracking Event**

**Appointments**
- **Appointment Status**:
  - Enrollment selector: "Contact only" / "Contact and Guests" / "Guests only".
  - Filters:
    - Event Type: Any / Normal / Recurring
    - Appointment Status: New, Confirmed, Cancelled, Showed, No-show, Invalid
    - Has Tag
    - In Calendar
    - In Calendar Group
    - Only for Grouped Calendar: Yes/No
    - Modified By: API, Customer, User (then pick the user), Workflow
- **Customer Booked Appointment**: same enrollment selector; filters "Has Tag", "In Calendar", "In Calendar Group".
- **Service Booking**
- **Rental Booking**

**Opportunities**
- **Opportunity Status Changed**: filters "Assigned To", "Tag" (formerly "Has Tag"), "In Pipeline", "Lead Value", "Moved From Status", "Moved To Status", "Pipeline Stage".
- **Opportunity Created**: filters Assigned To, Pipeline, Lead Value, Tag, Lost Reason, Status, plus "is empty" / "is not empty".
- **Opportunity Changed**: filters with event operators "Has Changed", "Has Changed To", "Equals" on Assigned To, Tag, In Pipeline, Lead Value change, date fields.
- **Pipeline Stage Changed**: filters "Assigned To", "Tag", "In Pipeline", "Lead Value", "Lost Reason", "Pipeline Stage", "Status".
- **Stale Opportunities**: filters "Duration in Days", "In Pipeline", "Pipeline Stage".

**Affiliate**
- Affiliate Created
- New Affiliate Sales
- Affiliate Enrolled In Campaign
- Lead Created

**Courses**
- Category Started
- Category Completed
- Lesson Started
- Lesson Completed
- New Signup
- Offer Access Granted
- Offer Access Removed
- Product Access Granted
- Product Access Removed
- Product Started
- Product Completed
- User Login

**Payments**
- **Invoice**: Invoice Status filter (Paid, Partially Paid, Sent, Viewed, Void), plus Tag and Custom Fields, and an Invoice Amount "Between" range.
- **Payment Received**:
  - Filters: Source (Calendar, External, Form, Funnel, Invoice, Manual Payment, Memberships, Website), "Global Product", "Payment Status" (e.g., Success), Calendar.
  - "+ Add filters" then "Save Trigger".
- **Order Form Submission**
- **Order Submitted**
- **Documents & Contracts**
- **Estimates**
- **Subscription**: Status filter (Active, Canceled, Expired, Incomplete Expired, Incomplete, Overdue, Scheduled, Trial, Unpaid) and "Global Products" (Is / Is not / Is empty / Is not empty).
- **Refund**
- **Coupon Code Applied**
- **Coupon Redemption Limit Reached**
- **Coupon Code Expired**
- **Coupon Code Redeemed**

**Ecommerce Stores**
- Shopify Abandoned Cart (Deprecating Soon)
- Shopify Order Placed
- Shopify Order Fulfilled (Deprecating Soon)
- Order Fulfilled
- Product Review Submitted
- Abandoned Checkout

**IVR**
- Start IVR Trigger

**Facebook/Instagram Events**
- Facebook – Comment(s) On A Post
- Instagram – Comment(s) On A Post

**Communities**
- Group Access Granted
- Group Access Revoked
- Private Channel Access Granted
- Private Channel Access Revoked
- Community Group Member Leaderboard Level Changed

**Certificates**
- Certificates Issued

**Communication**
- TikTok – Comment(s) On A Video
- Transcript Generated

**Google Ads**
- Google Lead Form Submitted

**Additional triggers documented in separate 2025–26 articles but missing from that list [C]:**
- **User Replied** (under Events): fires when a team member's message from the conversation view is delivered. Filters:

  | Filter | Operator | Values |
  |---|---|---|
  | Sent By / "Replied By" | Is any of | Grouped user picker: assigned user or specific users |
  | Message Channel | Is any of | SMS, Email, WhatsApp, Facebook Messenger, Instagram DM, Live Chat |
  | Contains Phrase | Contains | free text |
  | Exact Match Phrase | Equals | free text |
  | Has Tag / Doesn't Have Tag | Has any of | tag picker |
  | Has attachments | — | — |
  | Message body | — | — |

- Inbound Email
- Client Portal File Uploaded
- Company Created / Company Changed (company-based workflows)
- Custom-object record triggers
- SLA triggers (June 2026)
- Live Chat triggers
- Marketplace/integration triggers (ClickUp, Airtable, Google Contacts, Notion, Basecamp, Typeform, Asana, Monday.com, Google Forms, Vapi, Manus, Fathom, Apify, Cal.com, HubSpot, Klaviyo, Browse AI, Housecall Pro, Calendly, Todoist, Pipedrive, Jotform, …)

**General trigger behaviour [C]:**
- Multiple triggers are OR'd. Any trigger enrolls the contact.
- Every trigger has a user-given name (defaults to the type) and optional filters. Filters within a trigger are AND-ed; Tag filters support Any of / All of since Feb 2026.
- **Premium triggers** (e.g., Inbound Webhook) cost per execution (§9).
- Re-entry is governed by Settings, except that appointment and invoice triggers always allow re-entry per appointment or invoice.

Sources:
- https://help.gohighlevel.com/support/solutions/articles/155000002292-a-list-of-workflow-triggers
- Per-trigger articles: 48001213546, 155000002550, 155000002677, 155000002619, 155000002675, 155000003147, 155000006653, 155000002552, 155000002678, 155000003534, 155000002835, 155000003536, 155000002477, 155000002486, 155000002670, 155000002674, 155000003261, 155000002493, 155000003252, 155000002492, 155000000886, 155000003499, 155000003263, 155000008196
- Screenshots 155070070473 and the 2026 User-replied PNG
- Video: GHL Wizard 2026 (reads the picker category by category)

---

## 4. Actions (full list, grouped)

### 4.1 Official "complete list" (modified 3 Jun 2026) [C]

**Contact**
- Create Contact
- Find Contact
- Update Contact Field: "Update field data" / "Clear field data"; static or Dynamic value
- Add Contact Tag
- Remove Contact Tag
- Assign to User
- Remove Assigned User
- Edit Conversation: mark read/unread, archive/unarchive
- Disable/Enable DND (picker label "Enable/Disable DND")
- Add Note (picker label "Add To Notes")
- Add Task
- Copy Contact (premium)
- Delete Contact
- Modify Contact Engagement Score
- Add/Remove Contact Followers

**Communication**
- Send Email:
  - "From Name", "From Email", "Subject", "Templates", body (email builder).
  - CC/BCC buttons, attachments, test email.
  - Also an AI email generation option.
- Send SMS
- Send Slack Message (premium; picker label "Slack")
- Call (with an advanced "Disable Voicemail Detect")
- Voicemail
- Messenger
- Instagram DM
- Manual Action (Manual SMS / Manual Call)
- GMB Messaging
- Send Internal Notification. Types:
  - "Email": "From Name", "From Email", "To User Type", CC/BCC, "Subject"
  - "Notification" (in-app)
  - "SMS"
  - "WhatsApp"
  - Rate limit: 500 per user per 5 min.
- Send Review Request
- Conversation AI
- Facebook Interactive Messenger
- Instagram Interactive Messenger
- Reply in Comments
- WhatsApp (plus "WhatsApp Customer Service Window Check" and others)
- Send Live Chat Message

**Send Data**
- Webhook / Custom Webhook (premium; OAuth2 and secure credentials)
- Google Sheets (premium)

**Internal Tools** (picker heading "Internal")
- If Else
- Wait Step
- Goal Event
- Split
- Update Custom Value
- Go To
- Remove from Workflow
- Arrays
- Drip Mode
- Text Formatter
- Custom Code (JS; Python since Jun 2026; "Custom Code AI")

**Workflow AI**
- AI Prompt (GPT powered; the article title is "GPT Powered by OpenAI")

**Eliza**
- Eliza AI Appointment Booking
- Send to Eliza Agent Platform

**Appointments**
- Update Appointment Status
- Generate One Time Booking Link

**Opportunities**
- Create/Update Opportunity
- Remove Opportunity

**Payments**
- Stripe One-Time Charge
- Send Invoice
- Send Documents and Contracts

**Marketing**
- Add to Google Analytics
- Add to Google AdWords
- Add to Custom Audience (Facebook)
- Remove from Custom Audience (Facebook)
- Facebook Conversion API

**Affiliate**
- Add to Affiliate Manager
- Update Affiliate
- Add/Remove from Affiliate Campaign

**Courses**
- Course Grant Offer
- Course Revoke Offer

**IVR**
- Gather Input on Call
- Play Message
- Connect to Call
- End Call
- Record Voicemail

**Communities**
- Grant Group Access
- Revoke Group Access

### 4.2 Additional actions present in 2025–26 (other articles and picker narration) [C unless marked]

- **Internal extras**:
  - "Math Operation": numeric, monetary or date field. The operation can be add, subtract, multiply or divide, or a date offset. "Update field"; negative results become 0.
  - "Number Formatter"
  - "Date/Time Formatter"
  - "Add to Workflow" with option "Pass Input Trigger Parameters"
  - "Set Event Start Date"
  - "Array functions" / "Array Formatter"
- **Workflow AI actions**:
  - "AI Decision Maker"
  - "AI Intent Detection"
  - "AI Summarize"
  - "AI Translate"
  - "AI Agent" (Beta, premium crown)
  - "AI Extract Data"
  - "AI Email Parser"
  - "AI Image Generation"
  - "AI Analyze Image"
  - "Update Conversation AI Bot and Status"
  - "Invoke Agent Studio Agent"
  - "Invoke Managed Agent"
  - "OpenRouter Generate Response"
  - Mistral AI actions
  - "Email Verification"
- **Appointments extras**: "Create Appointment Booking Note".
- **Opportunities extras**:
  - "Add owner to opportunity", "Remove owner from opportunity"
  - "Add followers to an opportunity", "Remove followers from opportunity"
  - "Find Opportunity", "Create Opportunity", "Update Opportunity"
- **Payments extras**: "Send Estimate", "Send Recurring Invoice".
- **Marketing extras**: "Meta Conversion API" naming, "Generate Marketing Audit Report".
- **Affiliate extras**: "Add Leads under an Affiliate", "Add Manual Sales For An Affiliate".
- **Certificates**: "Issue Certificates".
- **Communities extras**: smart push notification, private channel access grant/revoke, leaderboard points.
- **Company** (Beta): create / update / clear associated company.
- **Custom Objects**:
  - "Create an Associated Record for Contact"
  - "Update an Associated Record for Contact"
  - "Clear Fields of Associated Record for Contact"
  - "Add/Remove Associated Records to/from Workflow"
  - "Find Object Record / Find Company"
  - "Associate Records"
- **Conversation AI category**: "AI capture information", "AI book appointment", "End conversation", "AI splitter", "AI message", "Custom message", "Transfer bot", "Continue conversation".
- **WhatsApp extras**: Send flows, interactive message, media, log external call; also "TikTok interactive messenger".
- **Agent Studio** and "Inbound AI voice caller" categories.
- **"Add Internal Comment"** (Conversations, Oct 2026).
- **Apps tab**: marketplace and integration actions (same vendor list as triggers).

These exact category headings are from the narrated picker; casing is [I].

### 4.3 Premium marker [C]

- A gold crown icon on the right of a picker row (e.g., "Copy Contact", "Slack", "AI Agent").

Sources:
- https://help.gohighlevel.com/support/solutions/articles/155000002294
- Folder listings of "Workflow Actions", "Internal Tools", "Workflow AI", "Communication", "CRM" (help.gohighlevel.com/support/solutions/48000455132)
- 48001216182 (Math), 48001214441 (Update Contact Field), 155000003202 (Internal Notification), 155000002472 (Send Email), 155000002554 (Add to Workflow)
- Video pgKCulPwEqg (picker narrated category by category)
- Screenshot 155070070473 (picker 2025), 2026 GIF frame (picker with "Recent Actions")

---

## 5. Logic steps in depth

### 5.1 If/Else [C]

- Drawer sections, top to bottom:
  - "Action Name"
  - "SCENARIO RECIPE": "Select from one of the pre-built condition templates". Dropdown default "Build Your Own"; prebuilt recipes are also available.
  - "BRANCHES"
- Each branch is a collapsible card:
  - Header: a name input (default "Branch", with a small char counter), a ⋮ menu, and a collapse chevron. A drag handle (6 dots) on the left reorders branches.
  - Body: condition rows of [field dropdown] [operator dropdown] [value] [trash].
  - Between rows is the connector word "AND" or "OR". A split button "[OR ▾][+]" or "[AND ▾][+]" adds a condition with that join.
  - "+ Add Segment" adds a new group of conditions inside the branch.
- Below the branches: "+ Add Branch" (blue tinted) on the left and "Reorder Branches" on the right.
- **"None Branch"** card: "When no condition is met". It is auto-created, has no conditions, cannot be removed, and can be renamed (default "None").
- Footer: "Delete" / "Cancel" / "Save Action".
- **Field picker**: searchable with folders, subfolders and breadcrumbs. Includes contact fields, company fields, opportunity, appointment and trigger data, and "Current Day of week" / "Current Day of month". New fields in 2026: Contact Engagement Score, Attribution Medium ID, Note created by (Name), Task ID.
- **Right-hand value**: static or "Dynamic Value" (supported for numeric, date, select (needs option IDs) and monetary).
- **Operators seen elsewhere** (Wait conditions, same component): "Is", "Is not", "Contains", "Does not contain", "Is any of (comma separated)", "Is none of (comma separated)", "Is not empty", "Is empty". Numeric and date fields add comparisons [I].
- **Evaluation**: branches are checked in order [I: first match wins; reorderable]. If none match, the contact goes down the None branch.
- **Canvas**: "Condition" node ({ } icon), then branch header cards with a purple underline (see §2.5).

### 5.2 Wait (2026 version) [C]

- Drawer: "Action Name", then **"Selected Wait Type"** (a card with icon, type name, and a blue "Change Type" link).
- The type chooser offers 8 plain-language options. Order is contextual: after a Send action, "The contact to reply" moves to the top.

1. **"A set period of time"**
   - "Time period" (stepper) and "Unit" (seconds / minutes / hours / days). Each has a ⋮ to switch "Standard" ↔ "Dynamic" (custom variable).
   - "Advance window" toggle:
     - "Resume on": day chips Sun–Sat with checkboxes.
     - "Resume between hours": "Window" dropdown with start and end times, e.g., 09:00 AM–5:00 PM.
     - "Additional Filter": three dropdowns for day, month and year conditions.
2. **"A specific date and time"**
   - Date/time (Standard or Dynamic).
   - "When should the Contact proceed?": "On this date and time" / "Before this date" / "After this date" (+ duration).
   - "If this date has already passed": "Continue to next action" / "Exit Contact from automation" / "Go to specific step" / "Skip all outbound communication actions till next wait or event start date action".
3. **"A recurring schedule"**
   - Frequency: Weekly (days and time), Monthly (day N, or 1st/2nd/3rd/4th/Last weekday of selected months, stackable), Yearly (date).
   - "When should the Contact proceed?"
   - A "Next 5 scheduled recurrences" preview.
4. **"An upcoming appointment or booking"**
   - Type: "Appointment / Calendar Event" / "Service Booking" / "Invoice Due Date".
   - Proceed "At the scheduled time" / "Before" / "After" (months, days, hours, minutes).
   - The same "already passed" options as type 2.
   - With an appointment trigger, an info banner references the trigger appointment.
5. **"The contact to reply"**
   - "Reply To" channel (SMS, Email, …); requires a prior Send step.
   - "Timeout" toggle with duration.
6. **"The contact to take an action"**
   - "What action?" radios: "Clicks a trigger link" / "Email event (open, click, bounce, etc.)".
   - "Pick Email step To Wait for" ("Select a step") and "Select Email Event" (multi-chips, e.g., "Clicked ×").
   - "Timeout" toggle with number and unit.
7. **"Specific conditions to be met"**
   - "Segments": condition blocks with AND/OR, "Add Condition", "+ Add Segment".
   - Segments are OR'd: any true segment releases the contact.
   - "Timeout" toggle.
8. **"A user to reply"**
   - Reply channel; optional user (assigned user or specific users).
   - Timeout toggle; resolves on delivery.

- **Legacy names (2023–24)**, for reference: "Time Delay", "Event/Appointment Time", "Condition", "Contact Reply", "Trigger Link Clicked", "Email Event" (also "Wait for: …" wording). Older videos show "Wait For Reply or 2 Mins"-style node names.
- **Timeout branch**: docs (2026) state that timeout adds a "timeout branch" that the AI Builder can add or remove. The exact canvas labels are not visible in public sources [I].
- **Editing a Wait** does not change contacts already waiting.
- **Time window** (Settings) interacts with waits: a wait can end outside the window, but the next action fires only inside it.

### 5.3 Goal Event [C]

- "Action Name" and "Select Type of Goal". Goal types:
  - Form Submitted (multi-select)
  - Payment Received (status, product)
  - Invoice Paid (any invoice, or the one from a Send Invoice step)
  - Document Status (Viewed, Signed, Declined, Completed)
  - Email Events (Opened, Clicked, Unsubscribed, Complained, Marked as Spam)
  - Clicked a Trigger Link
  - Review Request Clicked (channel or link)
  - Contact Tag Added or Removed
  - Appointment Status (New, Confirmed, Showed, No-show…)
  - User Replied (user and channel)
  - Task Status (task created/completed; Jun 2026)
- **"If Contact Reaches This Goal Without Meeting Conditions"**: "End this workflow" / "Continue anyway" / "Wait until the goal is met".
- **Behaviour**: when the goal condition is met at any time while the contact is anywhere earlier in the workflow, the contact jumps to the goal step and skips the steps in between.

### 5.4 Go To [C]

- Add a "Go To" action, then draw a line to the target step (a jump within the same workflow; can create intentional loops).
- In Advanced Builder, also used with branch merging.
- Distinct from Advanced "trigger Go-To connections", which are dashed lines from a trigger (§2.4).

### 5.5 Split [C]

- "Distribution Type": "Random Split" (the only option).
- "Paths": up to 5, renamable, each with a %. The total must equal 100%; 0% paths are allowed.
- A contact keeps its assigned path on re-entry.
- The action's Statistics tab shows the count per path.

### 5.6 Drip (action) [C]

- "Batch size" 1–10,000.
- "Drip interval": minutes (1–60), hours (1–24), days (1–7).
- Live "Drip Preview" table of up to 10 batches, with a warning when the workflow Time Window shifts batches.
- Statistics view: summary cards (contacts in drip, next batch, ETA), batch schedule table, status, and per-contact actions "move to next step" / "delete contact".
- Draft pauses the drip; republishing resumes pacing.
- Changing the batch size affects new contacts only (an info note says so).

### 5.7 Add to Workflow / Remove from Workflow [C]

- **Add to Workflow**: pick the target workflow; optional "Pass Input Trigger Parameters" (original trigger data only).
- **Remove from Workflow** options:
  - "Current Workflow"
  - "Another Workflow" (pick it)
  - "All Except Current Workflow"
  - "All Workflows"

### 5.8 Update Custom Value, Text/Number/Date formatters, Arrays, Custom Code, Math [C]

- These exist under Internal and write outputs usable by later steps as custom values. Field-level details are in the per-action articles.

Sources: 155000002471 (If/Else), 155000002470 (Wait, Sep 2026), 155000003328 (Goal), 48001196760 (Go To), 155000003304 (Split), 155000003360 (Drip), 155000002553, 155000002554, 48001216182; screenshots 155064138158, 155064138232, 155052094641; 2026 Wait GIF frames; growthable.io Wait article (legacy names): https://growthable.io/gohighlevel-tutorials/workflows/using-the-wait-action-in-the-workflow-builder-for-gohighlevel/ ; ItsKeaton video transcript https://www.youtube.com/watch?v=d5MvvGGpGCQ

---

## 6. Workflow Settings tab [C] (screenshot Oct 2025 and article Oct 2026)

Page heading "Workflow Settings". White cards on a light-grey page.

**Card "Contact"**
- **"Allow re-entry"** (toggle). Help text: "Allows a Contact to re-enter once it has left this workflow. If the Contact attempts to re-enter while it is still enrolled in this workflow, it will get skipped. Also if this workflow has appointment or invoice based triggers it will allow Contact to re-enter even if the 'Allow re-entry' setting is disabled. Learn More".
- **"Allow multiple Opportunities"** (toggle; on by default for new workflows). Help text: "Allows a Contact with multiple Opportunities to enter the workflow as separate executions…".
- **"Stop on response"** (toggle). Help text: "Ends workflow for a Contact if the Contact responds to a message that is sent from this workflow. Learn More".
  - It interacts with the Call action's "Disable Voicemail Detect".

**Card "Communication"**
- **"Timezone"** dropdown: "Account Timezone" / "Contact Timezone" (falls back to account). Help text: "Wait steps and Time window executions will proceed based on this timezone."
- **"Time Window"**: "Specific Time" toggle ("Restrict actions from being sent outside the window you define.").
  - "Start Time" / "End Time" dropdowns (e.g., 08:00 AM / 5:00 PM).
  - "Include Days": chip-checkboxes Sunday…Saturday.
  - Help text: "Execute actions if the current time falls in this window, else wait until the next window to execute the action. Wait steps can schedule for outside of the window, but the next action will only fire inside of it."
- **"Sender Details"**: "From Name" (tag icon), "From Email" (tag icon), "From Number" ("Select From Number" dropdown). These are defaults and can be overridden per action.
- **"Conversations"**: "Mark as read" toggle ("Toggle this on if you want the conversations that this Workflow will interact with to be marked as read.").

**Other settings-tab items**
- A "Pause Workflow" section (read-only info, with a link to Global Workflow Settings) when the workflow is in a pause range [C].
- Settings also host the builder default and switch controls (§1.9) [C].
- Third-party summaries mention "execution log settings" (who can see history) and "visibility settings". These are **not** in the official article [I, unverified].

Source: https://help.gohighlevel.com/support/solutions/articles/48001239875-workflow-settings-overview ; 155000006910 ; screenshots 155056948938, 155056949928

---

## 7. Enrollment History and Execution Logs [C]

### 7.1 Enrollment History tab

- Heading "Enrollment History", subtitle "View a history of all the contacts who have entered this Workflow".
- Filter bar:
  - A date range (YYYY-MM-DD → YYYY-MM-DD with a calendar icon). Presets: Today, Yesterday, … Custom range up to 30 days, with times.
  - "All Events" dropdown [I: filters by event/status].
  - A contact search/select.
  - A refresh button on the far right.
- Table columns: "Contact" (coloured initial avatar plus name), "Date Enrolled (IST +05:30)" (timezone shown in the header), "Current Action" (icon plus action name), "Current Status" (pill), "Next Execution On (…)" (e.g., "Not Available"), "Actions".
- Row actions:
  - "View Execution History" (clock icon).
  - "Highlight Contact Path" (path icon). It opens the builder with the path highlighted: error nodes, skipped nodes, entry/exit, in progress.
- Statuses include "Finished" (green pill), and the specific exit reasons "Workflow Completed", "Removed by Workflow Action" and "Removed by External Workflow Action".
  - Also "Removed by - Snapshot Refresh" and a "Contact Merge" entry in logs. Active/Waiting states also appear.
- Dates display as "Oct 17th, 3:17:50 pm" (older) or "MMM-DD" with the time on hover (2024 change).
- Footer: "Showing Page 1", a page-size dropdown (10 / 25 / 50), "← Previous", "Next →".

### 7.2 Execution Logs tab

- Heading "Execution Logs", subtitle "View a history and details of all executions performed by this Workflow".
- Filters: date range; "All actions" dropdown (actions in this workflow listed first, others in a separate section); "All Status"; contact select; refresh.
- Columns: "Contact", "Action" (the user-given action name with its icon; hover shows the type), "Status", "Executed On (IST +05:30)", "Actions".
- Row actions: a blue "View Details" link (highlighted when there is an error), clock = "View Execution History", person = "View Contact History", arrow-into-circle [I: "Go To Action", which opens the builder with that action's drawer].
- Status pills seen:
  - "Executed" (green), "Waiting" (grey), "Finished" (green), "Added To Workflow" (green).
  - Error rows are highlighted (red). Skipped steps are noted, e.g., contact-only steps in contactless runs.
  - [I: exact list of "All Status" options not published; likely Executed / Waiting / Skipped / Failed or Error / Finished.]
- Special system rows: "Add to workflow" (entry) and "Removed by - End Of Workflow" (exit).
- An acknowledge button marks errors as read; this links with the "Needs Review" tab.
- **Per-contact view** (from View Execution History):
  - A header card with avatar, the contact name with an external-link icon, "Execution History for <name>", and a "See contact path" button (blue tinted).
  - Breadcrumb "Logs / <Contact> / Execution ID - <uuid>" (clickable).
  - The same table without the Contact column.
- **Contact History**: all enrollments of that contact in this workflow.
- **"View Details"** opens a side panel with execution details [C: side panel mentioned].
- **Deep link**: Conversations → message details → "Workflow" → Execution Details (pre-filtered).

### 7.3 Manual enrollment and removal [C]

- **From a contact record**: "Automation" section, then "Add Workflow". Choose the workflow, set a start time, then "Add". Users can also remove the contact from a workflow there (all users, regardless of folder permissions).
- **Bulk**: Contacts → select (or "Select all") → bulk toolbar "Trigger automation" opens the **"Add to Automation"** dialog:
  - "Action Name"
  - "Automation Type: Workflow"
  - "Workflow" (published only)
  - "Mode": "Send All at Once" / "Send at Scheduled Time" ("Pick a Start Date & Time") / "Send in Drip Mode" ("Pick a Start Date & Time", "Number of Messages per Batch", "Repeat after" N Days/Hours/Minutes; plus Send On days, "Process Between" hours, "End At").
  - Then "Add to Automation", which shows a toast with "Check Progress" / "Dismiss". Progress is tracked on the Bulk Actions page.
- **Inside a workflow**: "Add to Workflow" / "Remove from Workflow" actions (§5.7). Drip stats offer "move to next step" and "delete contact".
- **Re-run of a single step**: not found in public sources [I: not a documented feature].

Sources: 155000003992 (Improved Execution Logs & Enrollment History, Apr 2026), 155000007595 (bulk add), 155000006472 (drip mode bulk), 155000002445 (FAQ manual add), 48001219648; screenshots 155035082350, 155035082869, 155035083212, 155035084528; white-label doc https://leadgrown.helpscoutdocs.com/article/41638-execution-logs-tab

---

## 8. Testing [C]

- **"Test Workflow"** (top-right) opens a right panel:
  - Title "Run A Test For Contact", subtitle "Select Contact to test this workflow".
  - Field label "SELECT CONTACTS" with a searchable "Select Contact" dropdown.
  - A blue "Run Test" button.
- **Behaviour**:
  - The test runs the workflow for the chosen contact, starting from the default path in Advanced Builder.
  - Docs warn it "isn't 100% perfect, especially if you reuse the same contact". Re-entry rules apply, so use a fresh contact.
  - The recommended approach is to publish and test live.
  - Results show in Enrollment History and Execution Logs.
- **Per-step "Test Action"** (integration actions only): see §2.7.
- **Disabling nodes** (pause icon) is the documented way to test variations.

Sources: 155000001254 (Testing the Workflow), 155000002288 (troubleshooting), 155000006635 (Default Path); screenshot 155039915593

---

## 9. 2025–2026 additions (chronological highlights) [C]

- **Workflow AI Builder** (Labs, on by default):
  - Entry points: list page "Build using AI", the in-builder prompt box, and the AI chatbot panel.
  - Modes: "Build" / "Chat mode" / "Point and Edit" (select steps, then instruct).
  - v3: live streaming progress cards, multi-step edits, session memory, generation in under 30 s, voice input.
  - Can change workflow settings.
  - Chat shows **artifact cards** per AI iteration: the current one has a purple border, with "Restore this version" and "Show in version history"; an "Unsaved" pill appears when auto-save is off.
  - "Learn Mode" with a "Continue in Build Mode" button.
  - Disable it per agency (Settings → Labs) or per location (Global Workflow Settings → Workflow AI).
- **AI "Suggestion → Add actions"** chip on the canvas (2025), the **"Learn more"** AI help button in every drawer, AI field tooltips, and "How to fix" (AI) for errors.
- **Advanced Builder** (Oct–Nov 2025): freeform canvas, trigger Go-To, delinked nodes, Default Path, sticky notes 2.0, comments, right-click menu, tidy-up, shortcuts, bulk select.
- **Auto Save** (Oct 2025), **Undo/Redo and Recent Changes**, **Version History revamp** (Dec 2025).
- **Workflow Switcher**, **Find & Replace** (Apr 2026), resizable and expandable sidebars (Aug 2026), dark-mode toggle [I].
- **Pause (enable/disable) individual actions** (Feb 2026, both builders).
- **Publish validation gate and "Resolve Errors" sidebar** (Sep 2026).
- **Trigger Narration and Trigger Stats** (Attempted / Matched / Unmatched with reasons).
- **Drag and drop** steps from the panel onto the canvas (Standard, 2026).
- **Wait action redesign** with 8 plain-language types (May 2026). **User Replied** trigger, wait and goal (Jul 2026). **SLA triggers** (Jun 2026). **Python in Custom Code** (Jun 2026). **OpenRouter** (300+ models) and **Invoke Agent Studio Agent** (Feb 2026). **AI Agent** action (Beta). **Add Internal Comment** action (Oct 2026).
- **Premium triggers/actions and Workflow Pro**:
  - 100 free lifetime premium executions per sub-account, then $0.01 per execution.
  - Plans: Starter $10/mo (10k executions, $0.008 overage), Growth $25 (30k, $0.006), Scale $50 (65k, $0.004).
  - Premium includes Inbound Webhook, Custom Webhook, Google Sheets, Slack, Marketplace and LC Apps (crown icon in the picker).
  - Agencies can rebill with a markup.
- **Company-based and custom-object-based workflows** (Create Workflow → "Company based workflow").

Sources: 155000006100 (AI Builder), 155000008368 (AI version history), 155000004871 (landing), 155000003971 & 155000005678 (Pro/premium), 155000004872, release radar https://netpartners.marketing/whats-new-in-gohighlevel/ and its June/February 2026 posts, HighLevel changelog https://ideas.gohighlevel.com/changelog

---

## 10. Visual design notes (for a faithful copy)

**Overall [C/I]**
- Clean SaaS look: white surfaces on a very light grey app background.
- Font appears to be **Inter** or a similar neo-grotesque [I]. Body text is about 14px; card titles 14–15px medium; page titles about 32px semibold ("Workflow List"); builder title about 20px medium.
- Primary colour is a saturated **blue** (about #155EEF / #1D4ED8 range [I]) used for:
  - primary buttons ("+ Create Workflow", "Save", "Run Test", "Save Action"),
  - active tab text plus a 2px underline,
  - links ("View Details", "Change Type", "Learn More"),
  - toggles (on = blue track, white knob),
  - the selected-node border.
- AI elements use **purple/violet gradients**: round floating AI button, "Build using AI" purple outline, sparkle icons, "Suggestion" pill with purple border and text.
- Status colours:
  - Published, Executed, Finished, Matched: **green** text on pale-green pills with a green border.
  - Draft, Waiting, Unmatched: **grey** pills.
  - Danger: **red** text ("Delete" buttons are white with red text and grey border; Bounced is red).
  - Version "Auto-saved": **amber** pill. The "View Only Mode" banner is pale yellow with an amber border. The "Stats view" pill is also pale yellow.
- Corner radii: buttons and inputs about 6–8px; cards about 8–12px; pills fully rounded [I from screenshots].

**Canvas [C]**
- Background is a light grey (#F2F4F7-ish [I]) with a dot grid (2024–25) or a thin square grid (2026).
- Connectors are 1px mid-grey (#98A2B3-ish [I]).
- Merging triggers are drawn with orthogonal lines that have rounded corners (about 12px radius).
- Branch splits use a horizontal bus line with rounded drops to each branch.

**Standard nodes [C]**
- See §2.5. White cards with a light border and a faint shadow.
- Icon tile about 36–44px with a pastel tint matching the glyph colour.
- Text is dark grey; the trigger "Trigger" label is blue.
- "···" overflow sits at the right in grey.
- Vertical spacing between action cards is about 100–130px at 100%, with the "+" centred in the gap.
- Branch columns are spaced about 300px apart [I].

**Advanced nodes [C]**
- Square tiles about 64–72px with about 14px radius and a soft shadow; label centred below in 14px dark text.
- Small grey connector dots on the left and right edges.
- Arrowheads at the target.
- Trigger Go-To links are dashed.
- A trailing "[+]" small square sits at the end of each chain.
- Sticky-note group backgrounds are large pastel rectangles (pink #FFE4E8-ish, peach #FDEBD3-ish [I]) with a bold black title at top-left.
- Selected node: blue ring.

**"Add New Trigger" [C]**
- Dashed 1px blue border with a pale-blue fill.
- A blue "+" inside a 32–40px pale-blue rounded square.
- Blue semibold label.

**Right drawer [C]**
- White, full height under the header, separated from the canvas by a border.
- Header: icon tile, title (16px semibold), grey description.
- Sections have either uppercase grey micro-labels (older: "WORKFLOW TRIGGER NAME", "FILTERS", "SELECT CONTACTS", "BRANCHES", "SCENARIO RECIPE") or sentence-case 14–15px labels (2026: "Action Name", "Selected Wait Type", "Time period").
- Inputs are full-width, about 40px tall, with grey borders.
- Sticky footer: "Delete" left, "Cancel" plus blue "Save action" right.
- The panel can be resized by dragging and expanded to full screen.

**Lists and tables [C]**
- Table header row is light grey with grey 13–14px labels; rows are about 64–80px tall with thin dividers.
- Kebab ⋮ on the far right; chevron ">" for expanding Stats.
- Dropdown menus are white with shadow, an icon plus label per item, and about 40px rows.

Sources: all screenshots listed above (opened and inspected).

---

## 11. Gaps and uncertainties (be careful when copying)

- Exact canvas labels of the **Wait timeout branches** (2026) are not shown publicly [I].
- Items of the Advanced Builder **right-click Quick Actions menu** and the **Workflow Comments** UI are named but not detailed.
- The full option list of Execution Logs **"All Status"** and Enrollment **"All Events"** filters is not published. Only Executed / Waiting / Finished / Added To Workflow and the exit reasons are confirmed.
- The three icon buttons next to Search on the list page are unlabeled in sources.
- **"Delete >"** submenu items in the node menu are inferred.
- Some 2026 category headings in the action picker ("Internal" vs "Internal Tools", "Workflow AI" vs "AI") differ between the help article and the live picker. The picker headings seen in screenshots are "Recent Actions", "Contact", "Communication". The help docs say "Under Internal, select Goal Event" / "Internal > Split".
- Pixel sizes and hex colours are estimates from screenshots, not design tokens.
