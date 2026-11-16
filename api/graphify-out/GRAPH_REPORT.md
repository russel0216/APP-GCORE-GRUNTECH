# Graph Report - api  (2026-11-12)

## Corpus Check
- 226 files · ~968,928 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, .prisma 1)

## Summary
- 4396 nodes · 16316 edges · 122 communities (119 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 209 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0ed6a33e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- statusLabel
- masters.ts
- sales.ts
- shared/insights.ts
- index.ts
- kit.ts
- routes/hr.ts
- resolve.ts
- can
- routes/academy.ts
- routes/aftermarket.ts
- jobs.ts
- scoroInvoices.ts
- verify-foundation.ts
- pdf.ts
- paper.ts
- routes/finance.ts
- salesOrders.ts
- warehouse.ts
- routes/evaluations.ts
- routes/budgetRequests.ts
- routes/hiring.ts
- verify-accounts.ts
- forecast.ts
- routes/partners.ts
- routes/peopleFlow.ts
- procurement.ts
- verify-hr.ts
- odoo.ts
- invoiceRequests.ts
- clearances.ts
- exhibitionVisitors.ts
- verify-sales.ts
- idsFilter
- pdfTemplates.ts
- pipeline.ts
- dayKey
- approvals.ts
- jobOrders.ts
- progress.ts
- pdfDesign.ts
- seed.ts
- shared/hr.ts
- num
- nextNumber
- badRequest
- commissions.ts
- liveness.ts
- routes/meetings.ts
- pullouts.ts
- verify-finance.ts
- planApprovals.ts
- Renderer
- @prisma/client
- routes/assets.ts
- costing.ts
- env.ts
- imports.ts
- audit
- officeBudget.ts
- shared/academy.ts
- face.ts
- verify-calendar.ts
- prisma.ts
- verify-delivery.ts
- attachments.ts
- main
- verify-meetings.ts
- verify-chain.ts
- quotation.ts
- costingMath.ts
- seed-sample-quotation.ts
- attendanceCorrections.ts
- lineCharges.ts
- inventory.ts
- plantilla.ts
- verify-pipeline.ts
- roles.ts
- shared/chain.ts
- manilaDayStart
- myRecords.ts
- shared/aftermarket.ts
- dependencies
- verify-masters.ts
- memos.ts
- devDependencies
- shared/holidays.ts
- receiptCost.ts
- compilerOptions
- approvalSlots
- team.ts
- orgChart.ts
- package.json
- pdfAttachments.ts
- canvassMath.ts
- orderStock.ts
- employeeNumbersFromList.ts
- manilaDate
- catalogue.ts
- num
- celebrations.ts
- scripts
- projectStock.ts
- typedItems.ts
- import-settings.ts
- sankey.ts
- printTickets.ts
- recalc
- checkReceivingSheet
- notify
- chainAccess.ts
- day.ts
- academySettings
- D
- present
- declaredValue.ts
- teamPosts.ts
- scopePreload.ts
- pickWorkflow
- morgan
- @types/bcryptjs@^2.4.6
- @types/morgan@^1.9.9

## God Nodes (most connected - your core abstractions)
1. `badRequest()` - 323 edges
2. `prisma` - 186 edges
3. `can()` - 165 edges
4. `audit()` - 159 edges
5. `notFound()` - 142 edges
6. `@prisma/client` - 131 edges
7. `nextNumber()` - 115 edges
8. `main()` - 110 edges
9. `idsFilter()` - 102 edges
10. `main()` - 100 edges

## Surprising Connections (you probably didn't know these)
- `signCosting()` --calls--> `act()`  [EXTRACTED]
  scripts/verify-costing.ts → src/shared/approvals.ts
- `main()` --calls--> `allPermissions()`  [EXTRACTED]
  prisma/seed.ts → src/permissions/registry.ts
- `main()` --calls--> `permissionsFor()`  [EXTRACTED]
  prisma/seed.ts → src/permissions/registry.ts
- `main()` --calls--> `splitBorrowedRights()`  [EXTRACTED]
  prisma/seed.ts → src/shared/accessSplit.ts
- `main()` --calls--> `seedActivityTypes()`  [EXTRACTED]
  prisma/seed.ts → src/shared/activityTypes.ts

## Import Cycles
- 2-file cycle: `src/shared/gops.ts -> src/shared/insights.ts -> src/shared/gops.ts`
- 3-file cycle: `src/shared/gops.ts -> src/shared/reportKit.ts -> src/shared/insights.ts -> src/shared/gops.ts`
- 4-file cycle: `src/shared/chain.ts -> src/shared/finance.ts -> src/shared/inventory.ts -> src/shared/reorder.ts -> src/shared/chain.ts`

## Communities (122 total, 3 thin omitted)

### Community 0 - "statusLabel"
Cohesion: 0.07
Nodes (115): presentAdvance(), presentBudgetRequest(), borrow(), canvass(), incoming(), inventory(), KINDS, outgoing() (+107 more)

### Community 1 - "masters.ts"
Cohesion: 0.03
Nodes (100): requireAny(), conflict(), ListResult, listResult(), ACTION_LABELS, assertCodeFree(), presentAsset(), templateCanEdit() (+92 more)

### Community 2 - "sales.ts"
Cohesion: 0.03
Nodes (86): ACTIVITY_INCLUDE, activitySchema, asDate(), BREAKDOWN_WORD, breakdownOfQuery(), checkActivityLinks(), checkLine(), checkQuoteNumber() (+78 more)

### Community 3 - "shared/insights.ts"
Cohesion: 0.05
Nodes (82): check(), cleanup(), D(), fig(), Figure, Line, main(), quotation() (+74 more)

### Community 4 - "index.ts"
Cohesion: 0.03
Nodes (81): app, webDist, academySettingsRoutes, courseRoutes, passportRoutes, sessionRoutes, AUDIT_SORTS, auditClock (+73 more)

### Community 5 - "kit.ts"
Cohesion: 0.04
Nodes (66): express, zod, authenticate(), bearer(), Express, require_(), requireAnyOrDecider(), requireSuperAdmin() (+58 more)

### Community 6 - "routes/hr.ts"
Cohesion: 0.04
Nodes (70): alreadyIn(), alreadyOut(), asDate(), ATTENDANCE_SORTS, capturedFrames(), capturedPhoto(), captureReader(), captureUpload (+62 more)

### Community 7 - "resolve.ts"
Cohesion: 0.03
Nodes (62): Action, ACTIONS, findSubmodule(), ModuleDef, OWNED, OWNED_KEPT, PermissionDef, READ (+54 more)

### Community 8 - "can"
Cohesion: 0.04
Nodes (64): Request, orderBy(), can(), ResolvedUser, assertTrainer(), registerReportSearch(), asDate(), BEFORE_QUEUE (+56 more)

### Community 9 - "routes/academy.ts"
Cohesion: 0.04
Nodes (66): activeCourse(), addAttendeesSchema, assertCanEdit(), assertCourseReadable(), CALENDAR_VIEW, cancelSchema, canEditSession(), clockFmt (+58 more)

### Community 10 - "routes/aftermarket.ts"
Cohesion: 0.04
Nodes (63): aftermarketRoutes, asDate(), assertNoReportOnReplannedVisits(), assetInclude, assetListSummary(), assetRoutes, AssetRow, assetSchema (+55 more)

### Community 11 - "jobs.ts"
Cohesion: 0.05
Nodes (60): RFC-6266, KIND_LABEL, asDate(), CategoryPosition, createJobSchema, CurvePoint, JOB_SORTS, JOB_STATUSES (+52 more)

### Community 12 - "scoroInvoices.ts"
Cohesion: 0.07
Nodes (62): errorMiddleware(), HttpError, linkGone(), teamFor(), methodOf(), OwnerChoice, ownerChoices(), ownerKey() (+54 more)

### Community 13 - "verify-foundation.ts"
Cohesion: 0.03
Nodes (9): PdfRun, runWidth(), signoffOverruns(), CLEARED_MARK, OVERRIDES_DROPPED_MARK, ROLES_CLEARED_MARK, ARCHIVE_ATTACHMENT, ARCHIVE_LIST_KEY (+1 more)

### Community 14 - "pdf.ts"
Cohesion: 0.07
Nodes (61): Align, autoWidths(), breakPoint(), caps(), CellLine, cellLines(), compactPeso(), Company (+53 more)

### Community 15 - "paper.ts"
Cohesion: 0.08
Nodes (59): Check, checkListPaper(), checkOwnPaper(), countedAs(), escapeRe(), flat(), get(), LANDSCAPE (+51 more)

### Community 16 - "routes/finance.ts"
Cohesion: 0.05
Nodes (57): ALL_PAYMENTS, asDate(), BILL_OWED, BILL_SORTS, BillBody, billInclude, BILLING_CARRIED, billListSummary() (+49 more)

### Community 17 - "salesOrders.ts"
Cohesion: 0.05
Nodes (58): paymentListSummary(), descriptionMemory(), breakdownSection(), changeWords(), comparedCells(), quotationListSummary(), revisionsMargin(), toCents() (+50 more)

### Community 18 - "warehouse.ts"
Cohesion: 0.06
Nodes (59): assertChangeIssue(), BORROW_SORTS, BORROW_TYPES, borrowLineSchema, borrowListWhere(), borrowSheetSchema, brandWhere(), cents() (+51 more)

### Community 19 - "routes/evaluations.ts"
Cohesion: 0.08
Nodes (57): api(), apiReachable(), check(), cleanup(), expectRejection(), HttpResult, iso(), Line (+49 more)

### Community 20 - "routes/budgetRequests.ts"
Cohesion: 0.04
Nodes (55): APPROVED_STATES, asDate(), assertCanOpen(), assertCanSee(), BUDGET_LIST_PERMISSIONS, budgetRequestRoutes, BudgetRow, budgetSections() (+47 more)

### Community 21 - "routes/hiring.ts"
Cohesion: 0.05
Nodes (51): CANDIDATE_SORTS, candidateInclude, CandidateRow, candidateSchema, checkContractDates(), checkMprRefs(), checkOpenMpr(), CONTRACT_EDIT_RIGHTS (+43 more)

### Community 22 - "verify-accounts.ts"
Cohesion: 0.07
Nodes (51): RFC-2047, Printed, apiReachable(), Captured, check(), cleanup(), decodedParts(), fakeSmtp() (+43 more)

### Community 23 - "forecast.ts"
Cohesion: 0.07
Nodes (57): listOf(), loadForecast(), namesOf(), addDays(), breakdownOf(), bucketKeyOf(), buildForecast(), cellOf() (+49 more)

### Community 24 - "routes/partners.ts"
Cohesion: 0.07
Nodes (51): apiReachable(), check(), cleanup(), http(), httpCases(), HttpResult, main(), makeRole() (+43 more)

### Community 25 - "routes/peopleFlow.ts"
Cohesion: 0.07
Nodes (55): baseWhere(), flowRows(), fullName(), itemBody, matches(), pathResponse(), present(), readable() (+47 more)

### Community 26 - "procurement.ts"
Cohesion: 0.04
Nodes (44): asDate(), assertCanvassVisible(), AwardSupplier, CANVASS_SORTS, canvassView(), CheckedPrLine, checkNature(), checkPoLines() (+36 more)

### Community 27 - "verify-hr.ts"
Cohesion: 0.08
Nodes (53): sharp, Box, eyesShut(), frameOf(), shearFrames(), stillFrames(), turnFrames(), api() (+45 more)

### Community 28 - "odoo.ts"
Cohesion: 0.08
Nodes (52): odooMigration(), activeEmployees(), assetRef(), buildAsset(), buildInventory(), cents(), chunks(), COLUMNS (+44 more)

### Community 29 - "invoiceRequests.ts"
Cohesion: 0.07
Nodes (52): currentUser(), forbidden(), notFound(), canEditRecord(), mayModifyContract(), forEdit(), load(), load() (+44 more)

### Community 30 - "clearances.ts"
Cohesion: 0.06
Nodes (51): impliedBy(), designTeam(), intoQueue(), linkOf(), settleCadJobOrder(), tell(), AREAS, asDay() (+43 more)

### Community 31 - "exhibitionVisitors.ts"
Cohesion: 0.08
Nodes (46): apiReachable(), check(), cleanup(), http(), main(), makeUser(), ALIASES, Brand (+38 more)

### Community 32 - "verify-sales.ts"
Cohesion: 0.08
Nodes (39): apiReachable(), approvedBy(), check(), cleanup(), d(), editorTokenIsSpare(), http(), HttpResult (+31 more)

### Community 33 - "idsFilter"
Cohesion: 0.08
Nodes (50): idsFilter(), passportRows(), sessionListWhere(), advanceListWhere(), assertCanSee(), ownOnly(), assetListWhere(), contractListWhere() (+42 more)

### Community 34 - "pdfTemplates.ts"
Cohesion: 0.09
Nodes (43): DOCS, documentType(), pdfTemplateRoutes, previewSchema, TemplateDoc, PrintableSalesOrder, printableSalesOrder(), COSTING_COLUMN_LABELS (+35 more)

### Community 35 - "pipeline.ts"
Cohesion: 0.07
Nodes (49): allowedTargets(), assertOutcomeChange(), BOARD_COLUMNS, BoardColumn, BoardColumnOut, BoardKpis, BoardLead, BoardPerson (+41 more)

### Community 36 - "dayKey"
Cohesion: 0.09
Nodes (43): adminToken(), holidaysAside(), holidaysBack(), putHolidays(), squash(), check(), cleanup(), D() (+35 more)

### Community 37 - "approvals.ts"
Cohesion: 0.08
Nodes (45): TYPICAL_REQUESTER, settle(), settle(), act(), ActInput, agreedOn(), APPROVAL_SIGNOFF, ApprovalContext (+37 more)

### Community 38 - "jobOrders.ts"
Cohesion: 0.07
Nodes (44): agreedAmount(), asDate(), checkBelongs(), costingLabor(), crewOf(), IN_PROGRESS_WHERE, isoDay(), JOB_ORDER_SORTS (+36 more)

### Community 39 - "progress.ts"
Cohesion: 0.07
Nodes (39): asDate(), BILLING_COUNTED, BILLING_SORTS, billingListInclude, billingPreparer(), billingRoutes, billingTrail(), cents() (+31 more)

### Community 40 - "pdfDesign.ts"
Cohesion: 0.05
Nodes (42): pdfkit@^0.15.1, pdfkit, checkedDesign(), columnLabel(), ALIGNS, ANCHORS, base, boxBlock (+34 more)

### Community 41 - "seed.ts"
Cohesion: 0.09
Nodes (37): main(), prisma, SeedStep, WORKFLOWS, WorkflowSeed, ADMIN_EMAIL, AdminEmailMove, moveAdminEmail() (+29 more)

### Community 42 - "shared/hr.ts"
Cohesion: 0.08
Nodes (42): at(), correctedTimes(), settleAttendanceCorrection(), manilaMinutesOfDay(), FACE_ENGINE, deletePhotoIfUnused(), describeRefusalReason(), dropAccountPhotoFromSamples() (+34 more)

### Community 43 - "num"
Cohesion: 0.11
Nodes (43): advanceListSummary(), budgetRequestListSummary(), recordOrProjectBudget(), commissionListSummary(), billMoney(), claimLines(), claimListSummary(), claimNotApplied() (+35 more)

### Community 44 - "nextNumber"
Cohesion: 0.11
Nodes (40): api(), apiReachable(), check(), cleanup(), expectRejection(), HOUSE, HttpResult, issueOf() (+32 more)

### Community 45 - "badRequest"
Cohesion: 0.11
Nodes (40): badRequest(), checkCharging(), checkCharging(), requestCharging(), sourceFromQuery(), standInCategory(), billOfficeLine(), checkPurchaser() (+32 more)

### Community 46 - "commissions.ts"
Cohesion: 0.08
Nodes (36): advanceStage(), checkSheet(), COMMISSION_LINK(), D(), loadVisible(), mayEdit(), mayPay(), mayRaiseCommission() (+28 more)

### Community 47 - "liveness.ts"
Cohesion: 0.07
Nodes (39): livenessGate(), b64(), BLINK_RATIO, Box, boxOf(), Challenge, CHALLENGE_KINDS, CHALLENGE_MESSAGES (+31 more)

### Community 48 - "routes/meetings.ts"
Cohesion: 0.07
Nodes (36): addInviteesSchema, agreeSchema, cancelSchema, clockFmt, dateTimeFmt, detailSelect, invitableUsers(), inviteeIds (+28 more)

### Community 49 - "pullouts.ts"
Cohesion: 0.09
Nodes (36): asDate(), cents(), checkSheet(), D(), lineSchema, LIST_INCLUDE, listWhere(), LoadedSlip (+28 more)

### Community 50 - "verify-finance.ts"
Cohesion: 0.11
Nodes (35): hasLine(), labelsSaid(), approvedByCount(), cents(), check(), cleanup(), D(), expectRejection() (+27 more)

### Community 51 - "planApprovals.ts"
Cohesion: 0.07
Nodes (33): scheduleTally(), CLEARED_CUSTOMER, decisionLabel(), jobInclude, kickoffChart(), KickoffJob, kickoffRoutes, loadJob() (+25 more)

### Community 52 - "Renderer"
Cohesion: 0.15
Nodes (14): formatDateTime(), pdfSafe(), safeSection(), safeSpec(), byPosition(), drawLaid(), fontName(), isAbove() (+6 more)

### Community 53 - "@prisma/client"
Cohesion: 0.08
Nodes (32): @prisma/client, ADVANCE_CLOSED, ADVANCE_SORTS, advanceInclude, advanceRoutes, AdvanceRow, advanceSchema, asDate() (+24 more)

### Community 54 - "routes/assets.ts"
Cohesion: 0.07
Nodes (31): deleteOrRefuse(), assetRoutes, checkType(), detailsOf(), include, LEAVING, nameOf(), openIssuance (+23 more)

### Community 55 - "costing.ts"
Cohesion: 0.07
Nodes (33): assignSchema, categoryRanks(), checkReferences(), checkVatRate(), COSTING_SORTS, costingAppendix(), costingPaper(), costingRoutes (+25 more)

### Community 56 - "env.ts"
Cohesion: 0.09
Nodes (27): bcryptjs, between(), pdfText(), clearing, create(), D(), ITEMS, PEOPLE (+19 more)

### Community 57 - "imports.ts"
Cohesion: 0.09
Nodes (29): customerSpec, EmployeeImportRecord, employeesImport, employeeSpec, EMPLOYMENT_TYPES, ITEM_TYPES, LARGE_IMPORTS, odooAssetsImport (+21 more)

### Community 58 - "audit"
Cohesion: 0.08
Nodes (25): audit(), AuditAction, AuditInput, ipOf(), REDACTED, moveCanvassCode(), OURS, applyEmployeeNumbering() (+17 more)

### Community 59 - "officeBudget.ts"
Cohesion: 0.11
Nodes (31): availableAfterFor(), requestBudget(), PlaceCard, advanceOffice(), ASKED, billOffice(), cents(), chargeAgainstOffice() (+23 more)

### Community 60 - "shared/academy.ts"
Cohesion: 0.09
Nodes (31): ACADEMY_DEFAULTS, AcademySettings, applyResults(), ATTENDEE_RESULTS, AttendeeResultValue, bestRecord(), CourseRef, courseSelect (+23 more)

### Community 61 - "face.ts"
Cohesion: 0.09
Nodes (27): start(), connectDb(), startActivityReminders(), accountPhotoFrom(), AVATAR_PX, centre(), describe(), detect() (+19 more)

### Community 62 - "verify-calendar.ts"
Cohesion: 0.09
Nodes (10): apiGet(), apiReachable(), apiSend(), check(), cleanup(), main(), makeRole(), makeUser() (+2 more)

### Community 63 - "prisma.ts"
Cohesion: 0.09
Nodes (22): prisma, ACTIVITY_ENUM_KEYS, ActivityEnumKey, activityEnumOf(), activityTypeKey(), activityTypeNames(), BUILTIN_ACTIVITY_TYPES, seedActivityTypes() (+14 more)

### Community 64 - "verify-delivery.ts"
Cohesion: 0.13
Nodes (26): rolesLike(), apiReachable(), check(), cleanup(), d(), http(), HttpResult, iso() (+18 more)

### Community 65 - "attachments.ts"
Cohesion: 0.12
Nodes (26): pendingCount(), slotsSaid(), apiReachable(), bells(), check(), cleanup(), D(), http() (+18 more)

### Community 66 - "main"
Cohesion: 0.09
Nodes (28): contentStreams(), pdfPieces(), shown(), winAnsi(), check(), cleanup(), expectRejection(), main() (+20 more)

### Community 67 - "verify-meetings.ts"
Cohesion: 0.16
Nodes (27): splittingValue(), api(), apiReachable(), at(), check(), cleanup(), expectRejection(), HttpResult (+19 more)

### Community 68 - "verify-chain.ts"
Cohesion: 0.14
Nodes (27): pdf-lib@^1.17.1, pdf-lib, names(), api(), apiReachable(), approvalSlot(), approvedBy(), approvedByCount() (+19 more)

### Community 69 - "quotation.ts"
Cohesion: 0.10
Nodes (26): canSeeQuotationCost(), CostingForQuote, costingsForQuote(), CostPanel, D(), DEFAULT_QUOTATION_CURRENCY, LINE_COST_KEYS, lineAmount() (+18 more)

### Community 70 - "costingMath.ts"
Cohesion: 0.13
Nodes (24): cents(), CostingFigures, costingFigures(), CostingRates, lineAmount(), lineAmountCents(), MathLine, MILLION (+16 more)

### Community 71 - "seed-sample-quotation.ts"
Cohesion: 0.13
Nodes (22): d(), deleteStray(), ISSUED, LINES, main(), ORDER_DESCRIPTIONS, ORDERS, pickOwner() (+14 more)

### Community 72 - "attendanceCorrections.ts"
Cohesion: 0.12
Nodes (23): attendanceCorrectionRoutes, attendanceCorrectionWork(), body, CORRECTION_LINK(), EDIT_KEYS, include, keyOf(), KEYS (+15 more)

### Community 73 - "lineCharges.ts"
Cohesion: 0.16
Nodes (20): claimCharges(), cents(), Db, num(), requestGroups(), requestPlaces(), spreadOver(), cardsFor() (+12 more)

### Community 74 - "inventory.ts"
Cohesion: 0.22
Nodes (22): reverseIncurred(), D(), postReceiving(), postStockIssue(), dropPlaceholder(), availableBudget(), borrowStock(), cents() (+14 more)

### Community 75 - "plantilla.ts"
Cohesion: 0.12
Nodes (21): backfillPositions(), mirrorPositionTitle(), PlantillaSummary, POSITION_JOIN, positionFields(), refreshPositionTitle(), setEmployeePosition(), setExtraPositions() (+13 more)

### Community 76 - "verify-pipeline.ts"
Cohesion: 0.16
Nodes (20): isBold(), labelRuns(), pdfRuns(), apiReachable(), BoardBody, BoardCard, cents(), check() (+12 more)

### Community 77 - "roles.ts"
Cohesion: 0.13
Nodes (17): CHART_KEYS, allPermissions(), permissionsFor(), ACCESS_SPLIT, FIRST_RUN, splitBorrowedRights(), PROJECT_MANAGER_GRANTS, PROJECT_MANAGER_ONLY (+9 more)

### Community 78 - "shared/chain.ts"
Cohesion: 0.19
Nodes (20): inventoryListWhere(), usersInRole(), availableOf(), belowReorder(), chainOverview(), itemsOnOrder(), num(), Qty (+12 more)

### Community 79 - "manilaDayStart"
Cohesion: 0.23
Nodes (21): auditListWhere(), visitListWhere(), cadListWhere(), commissionListWhere(), customerListWhere(), invoiceListWhereAll(), paymentListWhere(), ticketListWhere() (+13 more)

### Community 80 - "myRecords.ts"
Cohesion: 0.15
Nodes (18): myRecordsRoutes, HrSettings, Cutoff, CUTOFF_DEFAULT, cutoffByKey(), cutoffFor(), CutoffMode, CutoffRule (+10 more)

### Community 81 - "shared/aftermarket.ts"
Cohesion: 0.10
Nodes (20): renewalsFor(), AftermarketSettings, aftermarketSettings(), ChargeBasisValue, Coverage, currentTemplate(), DEFAULTS, Expiry (+12 more)

### Community 82 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, bcryptjs@^2.4.3, compression@^1.7.5, cors@^2.8.5, express@^4.21.2, helmet@^8.0.0, jsonwebtoken@^9.0.2, @prisma/client@^6.19.3 (+12 more)

### Community 83 - "verify-masters.ts"
Cohesion: 0.21
Nodes (18): check(), cleanup(), main(), customerListSummary(), customerWrite(), itemListWhere(), supplierListSummary(), ColumnDef (+10 more)

### Community 84 - "memos.ts"
Cohesion: 0.12
Nodes (16): AUDIENCES, audienceSchema, checkedAudience(), day(), include, isRecipient(), load(), memoRoutes (+8 more)

### Community 85 - "devDependencies"
Cohesion: 0.11
Nodes (19): devDependencies, prisma@^6.19.3, tsx@^4.19.2, @types/cors@^2.8.17, @types/express@^4.17.21, @types/jsonwebtoken@^9.0.7, @types/multer@^1.4.12, @types/node@^22.10.5 (+11 more)

### Community 86 - "shared/holidays.ts"
Cohesion: 0.20
Nodes (17): holidayRoutes, schema, setHolidayKeys(), clean(), easter(), Holiday, HolidayKind, holidays() (+9 more)

### Community 87 - "receiptCost.ts"
Cohesion: 0.20
Nodes (18): awardedCanvass(), presentPo(), basisWords(), centavo(), CostBasis, CostedLine, CostedOrder, discountFactor() (+10 more)

### Community 88 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 89 - "approvalSlots"
Cohesion: 0.21
Nodes (16): routeSignoffs(), routeSignoffs(), awaitsApproval(), cashRequestSignatories(), quotationPrintData(), unroutedApproval(), unroutedOrderSignoff(), approvalSlots() (+8 more)

### Community 90 - "team.ts"
Cohesion: 0.22
Nodes (15): loadCandidate(), assertOrderVisible(), salesOrderListWhere(), viewScope(), fillOrderTeams(), fillQuotationTeams(), FIRST_INDUSTRY_SUCCESSOR, orderTeamWhere() (+7 more)

### Community 91 - "orgChart.ts"
Cohesion: 0.24
Nodes (13): main(), applyChartRolesByName(), applyOrgChart(), CHART_DEPARTMENTS, chartRoles(), fold(), grantSupervisorRole(), ORG_CHART (+5 more)

### Community 92 - "package.json"
Cohesion: 0.14
Nodes (13): dotenv@^16.4.7, multer@^2.0.0, description, @types/compression@^1.7.5, main, name, prisma, seed (+5 more)

### Community 93 - "pdfAttachments.ts"
Cohesion: 0.19
Nodes (10): PdfRow, A4, appendPdf(), AttachedFile, attachedFiles(), attachmentKind(), fitImage(), sizeLabel() (+2 more)

### Community 94 - "canvassMath.ts"
Cohesion: 0.23
Nodes (12): AwardSummary, awardSummary(), AwardWinner, canvassFigures(), ColumnFigures, lineAmountCents(), lowestPerLine(), MAX_SHEET_SUPPLIERS (+4 more)

### Community 95 - "orderStock.ts"
Cohesion: 0.29
Nodes (12): cents(), D(), issueOrderStock(), key(), num(), OrderMove, PO_OPEN, PR_LIVE (+4 more)

### Community 96 - "employeeNumbersFromList.ts"
Cohesion: 0.26
Nodes (9): main(), syncLoginFromEmployee(), applyEmployeeNumberList(), EMPLOYEE_NUMBER_LIST, fold(), NumberChange, NUMBERS_FROM_LIST_MARK, backfillLoginMirrors() (+1 more)

### Community 97 - "manilaDate"
Cohesion: 0.17
Nodes (12): asDate(), externalData(), pendingApprovals(), presentPassport(), today(), checkDay(), today(), today() (+4 more)

### Community 98 - "catalogue.ts"
Cohesion: 0.27
Nodes (11): odooPicturesWrite(), saveAttachmentBytes(), clearPhoto(), oldPhotos(), PHOTO_MAX_PX, photoBytes(), placeOnShelf(), setPhoto() (+3 more)

### Community 99 - "num"
Cohesion: 0.23
Nodes (12): batchSource(), forLabelOf(), fromRequestItem(), lineSuggestions(), notApplied(), num(), orderSource(), presentPr() (+4 more)

### Community 100 - "celebrations.ts"
Cohesion: 0.27
Nodes (11): annualDayIn(), Celebration, CelebrationKind, celebrationsBetween(), fillGreeting(), key(), manilaHour(), occurrencesBetween() (+3 more)

### Community 101 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, prisma:deploy, prisma:generate, prisma:migrate, prisma:push, prisma:studio (+3 more)

### Community 102 - "projectStock.ts"
Cohesion: 0.38
Nodes (10): backfillProjectStock(), cents(), D(), issueProjectStock(), key(), num(), ProjectMove, qty() (+2 more)

### Community 103 - "typedItems.ts"
Cohesion: 0.27
Nodes (9): Db, shelveSiteDeliveries(), SITE_WAREHOUSE_CODE, SITE_WAREHOUSE_NAME, siteWarehouse(), itemForTypedLine(), matchTypedItem(), repairProjectlessReceipts() (+1 more)

### Community 104 - "import-settings.ts"
Cohesion: 0.36
Nodes (6): isBookkeeping(), main(), SNAPSHOT_VERSION, main(), same(), Snapshot

### Community 105 - "sankey.ts"
Cohesion: 0.25
Nodes (7): SalesReportSpec, layoutSankey(), SankeyInput, SankeyLayout, SankeyLink, SankeyNode, share()

### Community 106 - "printTickets.ts"
Cohesion: 0.31
Nodes (8): issueTicket(), redeemTicket(), sign(), spent, sweep(), TICKET_REUSE_MS, TICKET_TTL_MS, TicketRefusal

### Community 107 - "recalc"
Cohesion: 0.32
Nodes (8): asDay(), d(), headerData(), ratesOf(), recalc(), spreadSections(), suppliersByName(), writeSheet()

### Community 108 - "checkReceivingSheet"
Cohesion: 0.32
Nodes (8): asDate(), checkBorrowSheet(), checkOutstanding(), checkReceivingSheet(), qty(), today(), noRateMessage(), isSiteWarehouse()

### Community 109 - "notify"
Cohesion: 0.39
Nodes (8): settleReceiving(), settleStockIssue(), tellIssuedTo(), tellReceived(), tellToConfirmAtSite(), tellWarehouse(), warehouseNotApplied(), notify()

### Community 110 - "chainAccess.ts"
Cohesion: 0.25
Nodes (6): applyChainAccess(), CHAIN_ACCESS_MARK, CHAIN_COMMON, CHAIN_MANAGER_ROLES, CHAIN_PR, CHAIN_PR_ROLES

### Community 111 - "day.ts"
Cohesion: 0.32
Nodes (6): DAY_OFF, fmt, HOLIDAY_KEYS, isoKey(), isWorkingDay(), isWorkingDow()

### Community 112 - "academySettings"
Cohesion: 0.38
Nodes (7): cleanup(), main(), EnrolContext, enrolContext(), academySettings(), saveAcademySettings(), categoryColors()

### Community 113 - "D"
Cohesion: 0.33
Nodes (7): cents(), D(), poVat(), recalcPo(), receivedPct(), writePoLines(), writePrLines()

### Community 114 - "present"
Cohesion: 0.33
Nodes (6): dayKey(), present(), round2(), scopeDates(), lineCodes(), planTasks()

### Community 115 - "declaredValue.ts"
Cohesion: 0.53
Nodes (5): applyDeclaredValueRule(), cents(), num(), PULLED_BACK, reverseJobCost()

### Community 116 - "teamPosts.ts"
Cohesion: 0.33
Nodes (5): seedSharedPosts(), SHARED_POST_SEED, TEAM_POST_KEYS, TEAM_POST_ROLES, TEAM_POSTS_MARK

### Community 117 - "scopePreload.ts"
Cohesion: 0.40
Nodes (3): PreloadPhase, SCOPE_PRELOAD, ScopeKind

### Community 118 - "pickWorkflow"
Cohesion: 0.67
Nodes (3): approvalConfigured(), assertRoutable(), pickWorkflow()

## Knowledge Gaps
- **7 isolated node(s):** `RFC-4180`, `RFC-5545`, `RFC-5545`, `RFC-4180`, `RFC-4180` (+2 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1336 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `badRequest()` connect `badRequest` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `forecast.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `odoo.ts`, `invoiceRequests.ts`, `clearances.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `idsFilter`, `pdfTemplates.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `pdfDesign.ts`, `shared/hr.ts`, `num`, `nextNumber`, `commissions.ts`, `liveness.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `planApprovals.ts`, `@prisma/client`, `routes/assets.ts`, `costing.ts`, `imports.ts`, `officeBudget.ts`, `shared/academy.ts`, `face.ts`, `attachments.ts`, `main`, `verify-meetings.ts`, `attendanceCorrections.ts`, `lineCharges.ts`, `inventory.ts`, `plantilla.ts`, `manilaDayStart`, `myRecords.ts`, `shared/aftermarket.ts`, `verify-masters.ts`, `memos.ts`, `team.ts`, `orderStock.ts`, `manilaDate`, `catalogue.ts`, `num`, `projectStock.ts`, `recalc`, `checkReceivingSheet`, `pickWorkflow`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **What connects `RFC-4180`, `RFC-5545`, `RFC-5545` to the rest of the system?**
  _7 weakly-connected nodes found - possible missing edges._
- **Should `statusLabel` be split into smaller, more focused modules?**
  _Cohesion score 0.07022222222222223 - nodes in this community are weakly interconnected._
- **Why does `prisma` connect `prisma.ts` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `pdf.ts`, `paper.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `verify-hr.ts`, `odoo.ts`, `invoiceRequests.ts`, `clearances.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `pdfTemplates.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `pdfDesign.ts`, `seed.ts`, `shared/hr.ts`, `nextNumber`, `badRequest`, `commissions.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `planApprovals.ts`, `@prisma/client`, `routes/assets.ts`, `costing.ts`, `env.ts`, `imports.ts`, `audit`, `officeBudget.ts`, `shared/academy.ts`, `verify-calendar.ts`, `verify-delivery.ts`, `attachments.ts`, `verify-meetings.ts`, `verify-chain.ts`, `quotation.ts`, `seed-sample-quotation.ts`, `attendanceCorrections.ts`, `lineCharges.ts`, `inventory.ts`, `plantilla.ts`, `verify-pipeline.ts`, `roles.ts`, `shared/chain.ts`, `myRecords.ts`, `shared/aftermarket.ts`, `verify-masters.ts`, `memos.ts`, `shared/holidays.ts`, `receiptCost.ts`, `team.ts`, `orgChart.ts`, `pdfAttachments.ts`, `orderStock.ts`, `employeeNumbersFromList.ts`, `catalogue.ts`, `celebrations.ts`, `typedItems.ts`, `import-settings.ts`, `chainAccess.ts`, `teamPosts.ts`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Should `masters.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.025701547338054027 - nodes in this community are weakly interconnected._
- **Why does `@prisma/client` connect `@prisma/client` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `verify-hr.ts`, `odoo.ts`, `invoiceRequests.ts`, `clearances.ts`, `verify-sales.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `seed.ts`, `shared/hr.ts`, `num`, `nextNumber`, `badRequest`, `commissions.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `planApprovals.ts`, `routes/assets.ts`, `costing.ts`, `env.ts`, `imports.ts`, `audit`, `officeBudget.ts`, `shared/academy.ts`, `prisma.ts`, `verify-delivery.ts`, `attachments.ts`, `verify-chain.ts`, `quotation.ts`, `seed-sample-quotation.ts`, `attendanceCorrections.ts`, `lineCharges.ts`, `inventory.ts`, `plantilla.ts`, `verify-pipeline.ts`, `shared/chain.ts`, `shared/aftermarket.ts`, `dependencies`, `memos.ts`, `shared/holidays.ts`, `receiptCost.ts`, `team.ts`, `orgChart.ts`, `package.json`, `orderStock.ts`, `employeeNumbersFromList.ts`, `catalogue.ts`, `celebrations.ts`, `projectStock.ts`, `typedItems.ts`, `import-settings.ts`, `declaredValue.ts`, `teamPosts.ts`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `sales.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.030621785881252923 - nodes in this community are weakly interconnected._