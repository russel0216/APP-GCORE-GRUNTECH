# Graph Report - api  (2026-11-26)

## Corpus Check
- 263 files · ~1,064,373 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, .prisma 1)

## Summary
- 4837 nodes · 17754 edges · 121 communities (118 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 227 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `45c5bda6`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- salesReports.ts
- masters.ts
- forecast.ts
- shared/insights.ts
- index.ts
- rfq.ts
- routes/hr.ts
- resolve.ts
- planApprovals.ts
- routes/academy.ts
- routes/aftermarket.ts
- jobs.ts
- scoroInvoices.ts
- verify-foundation.ts
- pdf.ts
- verify-plantilla.ts
- routes/finance.ts
- salesOrders.ts
- warehouse.ts
- routes/evaluations.ts
- routes/budgetRequests.ts
- routes/hiring.ts
- verify-accounts.ts
- handler
- routes/partners.ts
- routes/peopleFlow.ts
- procurement.ts
- statusLabel
- odoo.ts
- notFound
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
- prisma.ts
- shared/hr.ts
- invoiceRequests.ts
- nextNumber
- badRequest
- mail.ts
- liveness.ts
- routes/meetings.ts
- pullouts.ts
- verify-finance.ts
- attendanceCorrections.ts
- Renderer
- advances.ts
- routes/assets.ts
- costing.ts
- env.ts
- imports.ts
- finAccess.ts
- officeBudget.ts
- verify-aftermarket.ts
- face.ts
- verify-calendar.ts
- audit.ts
- verify-delivery.ts
- roles.ts
- day.ts
- verify-meetings.ts
- builkImport.ts
- shared/finance.ts
- costingMath.ts
- canvassMath.ts
- kit.ts
- lineCharges.ts
- verify-chain.ts
- routes/marketing.ts
- paper.ts
- stockMovements.ts
- shared/chain.ts
- evaluationRuns.ts
- masters.ts
- mail.ts
- dependencies
- verify-insights-brief.ts
- kit.ts
- devDependencies
- shared/holidays.ts
- formatShortDate
- compilerOptions
- projectBudget.ts
- workspace.ts
- orgChart.ts
- package.json
- badRequest
- cadJobOrders.ts
- plantilla.ts
- quotation.ts
- valueRevision
- courseCategories.ts
- pipelineStages.ts
- receiptCost.ts
- scripts
- pdfAttachments.ts
- inventory.ts
- import-settings.ts
- sankey.ts
- morgan
- @types/bcryptjs@^2.4.6
- myRecords.ts
- sales.ts
- @types/morgan@^1.9.9
- verify-hr.ts
- verify-academy.ts
- presentCanvass
- stockCardHistory.ts
- typedItemSplit.ts
- celebrations.ts
- submitForApproval
- commissions.ts
- team.ts
- catalogue.ts

## God Nodes (most connected - your core abstractions)
1. `badRequest()` - 337 edges
2. `prisma` - 215 edges
3. `can()` - 176 edges
4. `audit()` - 175 edges
5. `notFound()` - 150 edges
6. `@prisma/client` - 140 edges
7. `nextNumber()` - 123 edges
8. `main()` - 113 edges
9. `idsFilter()` - 105 edges
10. `statusLabel()` - 102 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `T`  [EXTRACTED]
  scripts/verify-hr.ts → src/shared/pdf.ts
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

## Communities (121 total, 3 thin omitted)

### Community 0 - "salesReports.ts"
Cohesion: 0.08
Nodes (51): gopsRoutes, filterWords(), flowsFor(), Line, MONTHS, namesLine(), Row, STATUSES (+43 more)

### Community 1 - "masters.ts"
Cohesion: 0.06
Nodes (43): requireAny(), templateCanEdit(), asDate(), checkRoleIds(), checkSupervisorId(), createEmployeeSchema, EMPLOYEE_SORTS, employeeRoutes (+35 more)

### Community 2 - "forecast.ts"
Cohesion: 0.07
Nodes (57): listOf(), loadForecast(), namesOf(), addDays(), breakdownOf(), bucketKeyOf(), buildForecast(), cellOf() (+49 more)

### Community 3 - "shared/insights.ts"
Cohesion: 0.07
Nodes (64): check(), cleanup(), D(), day(), expectRejection(), main(), makeJob(), makeQuotation() (+56 more)

### Community 4 - "index.ts"
Cohesion: 0.04
Nodes (55): app, COMMIT, STARTED_AT, webDist, AUDIT_SORTS, auditClock, auditRoutes, auditWhen() (+47 more)

### Community 5 - "rfq.ts"
Cohesion: 0.08
Nodes (25): current(), procurementSettingsRoutes, cents(), checkSuppliers(), createSchema, headerSchema, LIST_INCLUDE, LoadedRfq (+17 more)

### Community 6 - "routes/hr.ts"
Cohesion: 0.04
Nodes (67): allocateSchema, alreadyIn(), alreadyOut(), asDate(), ATTENDANCE_SORTS, capturedFrames(), capturedPhoto(), captureReader() (+59 more)

### Community 7 - "resolve.ts"
Cohesion: 0.05
Nodes (45): Action, ACTION_LABELS, ACTIONS, findSubmodule(), ModuleDef, OWNED, OWNED_KEPT, PermissionDef (+37 more)

### Community 8 - "planApprovals.ts"
Cohesion: 0.12
Nodes (19): decisionLabel(), EDITABLE, mayEdit(), num(), planInclude, PlanRow, planSchema, present() (+11 more)

### Community 9 - "routes/academy.ts"
Cohesion: 0.04
Nodes (62): academySettingsRoutes, activeCourse(), addAttendeesSchema, assertCanEdit(), assertCourseReadable(), CALENDAR_VIEW, cancelSchema, canEditSession() (+54 more)

### Community 10 - "routes/aftermarket.ts"
Cohesion: 0.03
Nodes (64): aftermarketRoutes, asDate(), assertNoReportOnReplannedVisits(), assetInclude, assetRoutes, AssetRow, assetSchema, ATTENDED (+56 more)

### Community 11 - "jobs.ts"
Cohesion: 0.09
Nodes (27): advanceStage(), KIND_LABEL, asDate(), checkBelongs(), include, isoDay(), load(), mayOpen() (+19 more)

### Community 12 - "scoroInvoices.ts"
Cohesion: 0.06
Nodes (65): teamFor(), methodOf(), OwnerChoice, ownerChoices(), ownerKey(), ownerQuestion(), PAYMENT_WORDS, QuoteRef (+57 more)

### Community 13 - "verify-foundation.ts"
Cohesion: 0.03
Nodes (32): contentStreams(), shown(), winAnsi(), check(), cleanup(), expectRejection(), pageOf(), pdfEdges() (+24 more)

### Community 14 - "pdf.ts"
Cohesion: 0.07
Nodes (65): costingAppendix(), Align, autoWidths(), caps(), CellLine, cellLines(), compactPeso(), Company (+57 more)

### Community 15 - "verify-plantilla.ts"
Cohesion: 0.08
Nodes (56): Check, checkListPaper(), checkOwnPaper(), countedAs(), escapeRe(), get(), LANDSCAPE, measurer (+48 more)

### Community 16 - "routes/finance.ts"
Cohesion: 0.04
Nodes (63): ALL_PAYMENTS, AMENDABLE, amendSchema, asDate(), awaitsApproval(), BILL_OWED, BILL_SORTS, BillBody (+55 more)

### Community 17 - "salesOrders.ts"
Cohesion: 0.07
Nodes (37): assertOrderVisible(), createSchema, directSchema, documentsOnOrder(), importedFromScoro(), lineFields, mainOrderNumber(), mayReleaseOrder() (+29 more)

### Community 18 - "warehouse.ts"
Cohesion: 0.04
Nodes (90): itemListWhere(), activeGroupNames(), asDate(), assertChangeIssue(), BORROW_SORTS, BORROW_TYPES, borrowLineSchema, borrowListWhere() (+82 more)

### Community 19 - "routes/evaluations.ts"
Cohesion: 0.08
Nodes (56): api(), apiReachable(), check(), cleanup(), expectRejection(), HttpResult, iso(), Line (+48 more)

### Community 20 - "routes/budgetRequests.ts"
Cohesion: 0.04
Nodes (68): APPROVED_STATES, asDate(), assertCanOpen(), assertCanSee(), BOOKABLE, bookSchema, BUDGET_LIST_PERMISSIONS, budgetRequestRoutes (+60 more)

### Community 21 - "routes/hiring.ts"
Cohesion: 0.05
Nodes (49): CANDIDATE_SORTS, candidateInclude, CandidateRow, candidateSchema, checkContractDates(), checkMprRefs(), checkOpenMpr(), CONTRACT_EDIT_RIGHTS (+41 more)

### Community 22 - "verify-accounts.ts"
Cohesion: 0.17
Nodes (16): ADMIN_RESET_HOURS, createLogin(), deliverLink(), Delivery, escapeHtml(), hashToken(), INVITE_DAYS, issueToken() (+8 more)

### Community 23 - "handler"
Cohesion: 0.05
Nodes (53): zod, handler(), HttpError, Appearance, APPEARANCE_KEY, appearanceRoutes, cleanMap(), cleanRules() (+45 more)

### Community 24 - "routes/partners.ts"
Cohesion: 0.07
Nodes (58): apiReachable(), check(), cleanup(), http(), httpCases(), HttpResult, main(), makeRole() (+50 more)

### Community 25 - "routes/peopleFlow.ts"
Cohesion: 0.07
Nodes (54): baseWhere(), flowRows(), fullName(), itemBody, matches(), pathResponse(), present(), readable() (+46 more)

### Community 26 - "procurement.ts"
Cohesion: 0.04
Nodes (55): assertCanvassVisible(), AwardSupplier, batchSource(), CANVASS_SORTS, canvassView(), cents(), CheckedPrLine, D() (+47 more)

### Community 27 - "statusLabel"
Cohesion: 0.26
Nodes (44): borrow(), canvass(), incoming(), inventory(), KINDS, outgoing(), overview(), pullout() (+36 more)

### Community 28 - "odoo.ts"
Cohesion: 0.04
Nodes (84): activeEmployees(), assetRef(), buildAsset(), buildInventory(), cents(), chunks(), COLUMNS, D() (+76 more)

### Community 29 - "notFound"
Cohesion: 0.14
Nodes (32): currentUser(), forbidden(), notFound(), canEditRecord(), forEdit(), load(), checkCharging(), assertMayAct() (+24 more)

### Community 30 - "clearances.ts"
Cohesion: 0.06
Nodes (45): impliedBy(), AREAS, asDay(), assertCanView(), CLEARANCE_SORTS, clearanceRoutes, Header, headerInclude (+37 more)

### Community 31 - "exhibitionVisitors.ts"
Cohesion: 0.09
Nodes (39): apiReachable(), check(), cleanup(), http(), main(), makeUser(), ALIASES, Brand (+31 more)

### Community 32 - "verify-sales.ts"
Cohesion: 0.07
Nodes (47): main(), apiReachable(), approvedBy(), asApproved(), check(), cleanup(), d(), editorTokenIsSpare() (+39 more)

### Community 33 - "idsFilter"
Cohesion: 0.09
Nodes (63): idsFilter(), passportRows(), sessionListWhere(), auditListWhere(), assetListWhere(), contractListWhere(), serviceReportListWhere(), visitListWhere() (+55 more)

### Community 34 - "pdfTemplates.ts"
Cohesion: 0.09
Nodes (41): DOCS, documentType(), pdfTemplateRoutes, previewSchema, TemplateDoc, canSeeOrderCost(), PrintableSalesOrder, COSTING_COLUMN_LABELS (+33 more)

### Community 35 - "pipeline.ts"
Cohesion: 0.06
Nodes (52): allowedTargets(), assertOutcomeChange(), BOARD_COLUMNS, BoardColumn, BoardColumnOut, BoardKpis, BoardLead, BoardPerson (+44 more)

### Community 36 - "dayKey"
Cohesion: 0.11
Nodes (30): adminToken(), holidaysAside(), holidaysBack(), putHolidays(), pdfPieces(), api(), apiReachable(), check() (+22 more)

### Community 37 - "approvals.ts"
Cohesion: 0.06
Nodes (48): TYPICAL_REQUESTER, tellWarehouse(), ActInput, agreedOn(), APPROVAL_SIGNOFF, ApprovalContext, bossInsteadOfCeo(), Contact (+40 more)

### Community 38 - "jobOrders.ts"
Cohesion: 0.04
Nodes (79): agreedAmount(), checkBelongs(), costingLabor(), crewOf(), IN_PROGRESS_WHERE, isoDay(), JOB_ORDER_SORTS, jobOrderInclude (+71 more)

### Community 39 - "progress.ts"
Cohesion: 0.07
Nodes (38): asDate(), BILLING_COUNTED, BILLING_SORTS, billingListInclude, billingPreparer(), billingRoutes, billingTrail(), cents() (+30 more)

### Community 40 - "pdfDesign.ts"
Cohesion: 0.06
Nodes (39): pdfkit@^0.15.1, pdfkit, ALIGNS, ANCHORS, base, boxBlock, CompanyRow, companyValues() (+31 more)

### Community 41 - "prisma.ts"
Cohesion: 0.04
Nodes (61): prisma, prisma, ACTIVITY_ENUM_KEYS, ActivityEnumKey, activityEnumOf(), activityTypeKey(), activityTypeNames(), BUILTIN_ACTIVITY_TYPES (+53 more)

### Community 42 - "shared/hr.ts"
Cohesion: 0.07
Nodes (51): settleAttendanceCorrection(), saveAttachmentBytes(), manilaMinutesOfDay(), accountPhotoFrom(), FACE_ENGINE, deletePhotoIfUnused(), describeRefusalReason(), dropAccountPhotoFromSamples() (+43 more)

### Community 43 - "invoiceRequests.ts"
Cohesion: 0.09
Nodes (49): mayRaiseCommission(), billingMoney(), checkBatch(), checkHeader(), customerOf(), headerSchema, INVOICE_REQUEST_LINK(), listRow() (+41 more)

### Community 44 - "nextNumber"
Cohesion: 0.09
Nodes (52): check(), cleanup(), main(), api(), apiReachable(), check(), cleanup(), expectRejection() (+44 more)

### Community 45 - "badRequest"
Cohesion: 0.20
Nodes (23): assertBudgetLeft(), auditOn(), budgetLineFor(), BUYABLE, cents(), checkQuotationTarget(), costsToReallocate(), D() (+15 more)

### Community 46 - "mail.ts"
Cohesion: 0.14
Nodes (19): RFC-2047, tell(), tell(), addressOf(), base64Lines(), buildMessage(), displayNameOf(), encodeHeader() (+11 more)

### Community 47 - "liveness.ts"
Cohesion: 0.07
Nodes (41): challengeOf(), livenessGate(), yawOf(), b64(), BLINK_RATIO, Box, boxOf(), Challenge (+33 more)

### Community 48 - "routes/meetings.ts"
Cohesion: 0.07
Nodes (35): addInviteesSchema, agreeSchema, cancelSchema, clockFmt, dateTimeFmt, detailSelect, invitableUsers(), inviteeIds (+27 more)

### Community 49 - "pullouts.ts"
Cohesion: 0.09
Nodes (37): asDate(), cents(), checkSheet(), D(), isServiceGroup(), lastParts(), lineSchema, LIST_INCLUDE (+29 more)

### Community 50 - "verify-finance.ts"
Cohesion: 0.14
Nodes (25): hasLine(), labelsSaid(), approvedByCount(), cents(), check(), cleanup(), D(), expectRejection() (+17 more)

### Community 51 - "attendanceCorrections.ts"
Cohesion: 0.06
Nodes (45): at(), attendanceCorrectionRoutes, attendanceCorrectionWork(), body, checkDay(), correctedTimes(), CORRECTION_LINK(), EDIT_KEYS (+37 more)

### Community 52 - "Renderer"
Cohesion: 0.16
Nodes (12): breakPoint(), formatDateTime(), byPosition(), drawLaid(), fontName(), isAbove(), laid(), lineWidth() (+4 more)

### Community 53 - "advances.ts"
Cohesion: 0.08
Nodes (37): RFC-6266, ADVANCE_CLOSED, ADVANCE_SORTS, advanceInclude, advanceListWhere(), advanceRoutes, AdvanceRow, advanceSchema (+29 more)

### Community 54 - "routes/assets.ts"
Cohesion: 0.10
Nodes (23): assetRoutes, checkType(), detailsOf(), include, LEAVING, loadSlip(), mayReadSlip(), nameOf() (+15 more)

### Community 55 - "costing.ts"
Cohesion: 0.07
Nodes (40): asDay(), assertCostingVisible(), assignSchema, COSTING_SORTS, costingRouteSlots(), d(), dayKey(), headerData() (+32 more)

### Community 56 - "env.ts"
Cohesion: 0.10
Nodes (28): bcryptjs, @prisma/client, between(), pdfText(), clearing, create(), D(), ITEMS (+20 more)

### Community 57 - "imports.ts"
Cohesion: 0.08
Nodes (34): courseImport, customerSpec, EmployeeImportRecord, employeesImport, employeeSpec, EMPLOYMENT_TYPES, importRoutes, ITEM_TYPES (+26 more)

### Community 58 - "finAccess.ts"
Cohesion: 0.18
Nodes (9): applyFinAccess(), FIN_ACCESS_MARK, FIN_COMMON, FIN_MANAGER_ROLE, FIN_SALES, FIN_SALES_ROLES, MONEY_IN_ACCESS_MARK, MONEY_IN_KEYS (+1 more)

### Community 59 - "officeBudget.ts"
Cohesion: 0.08
Nodes (43): availableAfterFor(), requestBudget(), assertNameFree(), cents(), checkCodes(), createSchema, D(), lineSchema (+35 more)

### Community 60 - "verify-aftermarket.ts"
Cohesion: 0.08
Nodes (39): signedCount(), splittingValue(), squash(), check(), cleanup(), D(), day(), expectRejection() (+31 more)

### Community 61 - "face.ts"
Cohesion: 0.08
Nodes (31): pastedFace(), start(), connectDb(), startActivityReminders(), AVATAR_PX, centre(), describe(), describeFace() (+23 more)

### Community 62 - "verify-calendar.ts"
Cohesion: 0.09
Nodes (10): apiGet(), apiReachable(), apiSend(), check(), cleanup(), main(), makeRole(), makeUser() (+2 more)

### Community 63 - "audit.ts"
Cohesion: 0.09
Nodes (18): AuditAction, AuditInput, ipOf(), REDACTED, applyChainAccess(), CHAIN_ACCESS_MARK, CHAIN_COMMON, CHAIN_MANAGER_ROLES (+10 more)

### Community 64 - "verify-delivery.ts"
Cohesion: 0.11
Nodes (30): flat(), referenceOf(), saysCount(), apiReachable(), check(), cleanup(), d(), http() (+22 more)

### Community 65 - "roles.ts"
Cohesion: 0.13
Nodes (15): CHART_KEYS, allPermissions(), ACCESS_SPLIT, FIRST_RUN, splitBorrowedRights(), PROJECT_MANAGER_GRANTS, PROJECT_MANAGER_ONLY, ROLE_SEEDS (+7 more)

### Community 66 - "day.ts"
Cohesion: 0.09
Nodes (36): aging(), APPROVED_ON, collectionForecast(), FIN_REPORT_KINDS, INVOICE_REPORT_SELECT, invoiceFilter(), InvoiceRow, KINDS (+28 more)

### Community 67 - "verify-meetings.ts"
Cohesion: 0.15
Nodes (28): api(), apiReachable(), at(), check(), cleanup(), expectRejection(), HttpResult, main() (+20 more)

### Community 68 - "builkImport.ts"
Cohesion: 0.07
Nodes (52): main(), check(), fold(), main(), check(), fold(), main(), check() (+44 more)

### Community 69 - "shared/finance.ts"
Cohesion: 0.14
Nodes (34): advanceListSummary(), presentAdvance(), financePartOf(), billMoney(), claimLines(), claimListSummary(), collectionCredit(), collectionEwt() (+26 more)

### Community 70 - "costingMath.ts"
Cohesion: 0.13
Nodes (24): cents(), CostingFigures, costingFigures(), CostingRates, lineAmount(), lineAmountCents(), MathLine, MILLION (+16 more)

### Community 71 - "canvassMath.ts"
Cohesion: 0.23
Nodes (12): AwardSummary, awardSummary(), AwardWinner, canvassFigures(), ColumnFigures, lineAmountCents(), lowestPerLine(), MAX_SHEET_SUPPLIERS (+4 more)

### Community 72 - "kit.ts"
Cohesion: 0.06
Nodes (39): express, authenticate(), bearer(), Express, Request, require_(), requireAnyOrDecider(), requireSuperAdmin() (+31 more)

### Community 73 - "lineCharges.ts"
Cohesion: 0.13
Nodes (24): requestCharging(), standInCategory(), claimCharges(), cents(), Db, num(), requestGroups(), requestPlaces() (+16 more)

### Community 74 - "verify-chain.ts"
Cohesion: 0.08
Nodes (56): names(), api(), apiReachable(), approvalSlot(), approvedBy(), approvedByCount(), awaits(), check() (+48 more)

### Community 75 - "routes/marketing.ts"
Cohesion: 0.09
Nodes (30): brandsLine(), brandsOf(), checkBrandIds(), clean(), exhibitionFor(), exhibitionSchema, findSame(), include (+22 more)

### Community 76 - "paper.ts"
Cohesion: 0.09
Nodes (30): pdf-lib@^1.17.1, pdf-lib, Clash, KINDS, main(), overlaps(), Row, isBold() (+22 more)

### Community 77 - "stockMovements.ts"
Cohesion: 0.12
Nodes (24): cents(), dayRange(), DIRECTIONS, DOCUMENT_KINDS, DocumentKind, DOCUMENTS, ITEM_SELECT, itemSearch() (+16 more)

### Community 78 - "shared/chain.ts"
Cohesion: 0.17
Nodes (22): inventoryListWhere(), availableOf(), belowReorder(), chainOverview(), itemsOnOrder(), num(), Qty, REORDER_CANDIDATES (+14 more)

### Community 79 - "evaluationRuns.ts"
Cohesion: 0.11
Nodes (27): conflict(), assertCodeFree(), assertLoginEmailFree(), mirrorEmployeeNo(), runningOrRefuse(), evaluationRunRoutes, evaluationRunWork(), isHr() (+19 more)

### Community 80 - "masters.ts"
Cohesion: 0.04
Nodes (37): activityTypeSchema, assertCategoryEdit(), AWAITING_PO, brandsWithoutGroup(), checkLevels(), costCategorySchema, courseCategorySchema, documentCategorySchema (+29 more)

### Community 81 - "mail.ts"
Cohesion: 0.24
Nodes (14): apiReachable(), Captured, check(), cleanup(), decodedParts(), fakeSmtp(), fieldsOf(), http() (+6 more)

### Community 82 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, bcryptjs@^2.4.3, compression@^1.7.5, cors@^2.8.5, express@^4.21.2, helmet@^8.0.0, jsonwebtoken@^9.0.2, @prisma/client@^6.19.3 (+12 more)

### Community 83 - "verify-insights-brief.ts"
Cohesion: 0.19
Nodes (16): check(), cleanup(), D(), fig(), Figure, Line, main(), quotation() (+8 more)

### Community 84 - "kit.ts"
Cohesion: 0.06
Nodes (45): deleteOrRefuse(), errorMiddleware(), ListQuery, ListResult, listResult(), MAX_SELECTED_IDS, parseBody(), RESERVED (+37 more)

### Community 85 - "devDependencies"
Cohesion: 0.11
Nodes (19): devDependencies, prisma@^6.19.3, tsx@^4.19.2, @types/cors@^2.8.17, @types/express@^4.17.21, @types/jsonwebtoken@^9.0.7, @types/multer@^1.4.12, @types/node@^22.10.5 (+11 more)

### Community 86 - "shared/holidays.ts"
Cohesion: 0.22
Nodes (16): holidayRoutes, schema, setHolidayKeys(), clean(), easter(), Holiday, HolidayKind, holidays() (+8 more)

### Community 87 - "formatShortDate"
Cohesion: 0.13
Nodes (29): slipPdf(), routeSignoffs(), categoryRanks(), costingPaper(), loadFull(), pct(), planLegend(), routeSignoffs() (+21 more)

### Community 88 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 89 - "projectBudget.ts"
Cohesion: 0.13
Nodes (24): budgetRequestListSummary(), OfficeFigures, ADVANCE_IN_FLIGHT, advanceBudget(), BudgetLine, BudgetPool, budgetPosition(), cents() (+16 more)

### Community 90 - "workspace.ts"
Cohesion: 0.07
Nodes (36): memosToAcknowledge(), actSchema, approvalRoutes, assignedTo(), attachmentRoutes, borrowWork(), byUrgency(), draftsOf() (+28 more)

### Community 91 - "orgChart.ts"
Cohesion: 0.12
Nodes (24): main(), main(), personName(), syncLoginFromEmployee(), applyEmployeeNumberList(), EMPLOYEE_NUMBER_LIST, fold(), NumberChange (+16 more)

### Community 92 - "package.json"
Cohesion: 0.14
Nodes (13): dotenv@^16.4.7, multer@^2.0.0, description, @types/compression@^1.7.5, main, name, prisma, seed (+5 more)

### Community 93 - "badRequest"
Cohesion: 0.10
Nodes (25): badRequest(), checkCharging(), checkReferences(), checkVatRate(), billOfficeLine(), asDate(), window(), checkTeam() (+17 more)

### Community 94 - "cadJobOrders.ts"
Cohesion: 0.06
Nodes (43): can(), asDate(), BEFORE_QUEUE, cadInclude, cadJobOrderRoutes, CadRow, cadSchema, checkLinks() (+35 more)

### Community 95 - "plantilla.ts"
Cohesion: 0.13
Nodes (20): backfillPositions(), mirrorPositionTitle(), PlantillaSummary, POSITION_JOIN, positionFields(), refreshPositionTitle(), setEmployeePosition(), setExtraPositions() (+12 more)

### Community 96 - "quotation.ts"
Cohesion: 0.06
Nodes (45): d(), deleteStray(), ISSUED, LINES, main(), ORDER_DESCRIPTIONS, ORDERS, pickOwner() (+37 more)

### Community 97 - "valueRevision"
Cohesion: 0.16
Nodes (20): quotationListSummary(), revisionsMargin(), toCents(), salesOrderListSummary(), inBase(), rateOf(), quotationValue(), valueRevision() (+12 more)

### Community 98 - "courseCategories.ts"
Cohesion: 0.18
Nodes (14): colorOf(), durationLabel(), EnrolContext, enrolContext(), presentCourse(), presentCourseRow(), sessionDays(), sessionSeat() (+6 more)

### Community 99 - "pipelineStages.ts"
Cohesion: 0.16
Nodes (14): DEFAULT_STAGES, mergeStages(), overrideSchema, pipelineStageOverrides(), pipelineStages(), probabilityAfterMove(), STAGE_KEYS, STAGE_SETTING_KEY (+6 more)

### Community 100 - "receiptCost.ts"
Cohesion: 0.12
Nodes (30): awardedCanvass(), presentPo(), cents(), D(), issueOrderStock(), key(), num(), OrderMove (+22 more)

### Community 101 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, prisma:deploy, prisma:generate, prisma:migrate, prisma:push, prisma:studio (+3 more)

### Community 102 - "pdfAttachments.ts"
Cohesion: 0.19
Nodes (10): PdfRow, A4, appendPdf(), AttachedFile, attachedFiles(), attachmentKind(), fitImage(), sizeLabel() (+2 more)

### Community 103 - "inventory.ts"
Cohesion: 0.09
Nodes (42): check(), main(), Rollback, lendItems(), postStockIssue(), applyDeclaredValueRule(), cents(), num() (+34 more)

### Community 104 - "import-settings.ts"
Cohesion: 0.22
Nodes (10): isBookkeeping(), main(), SNAPSHOT_VERSION, main(), same(), Snapshot, logoFile(), logoImage() (+2 more)

### Community 105 - "sankey.ts"
Cohesion: 0.22
Nodes (8): SalesReportSpec, layoutSankey(), SankeyInput, SankeyLayout, SankeyLink, SankeyNode, share(), topOfFlow()

### Community 108 - "myRecords.ts"
Cohesion: 0.13
Nodes (22): myRecordsRoutes, leaveBalance(), Cutoff, CUTOFF_DEFAULT, cutoffByKey(), cutoffFor(), CutoffRule, daysOf() (+14 more)

### Community 109 - "sales.ts"
Cohesion: 0.04
Nodes (75): ACTIVITY_INCLUDE, activitySchema, BREAKDOWN_WORD, breakdownOfQuery(), checkLine(), checkQuoteNumber(), createQuotationSchema, FORECAST_LEAD_STATUSES (+67 more)

### Community 111 - "verify-hr.ts"
Cohesion: 0.07
Nodes (53): sharp, Box, eyesShut(), frameOf(), shearFrames(), stillFrames(), turnFrames(), api() (+45 more)

### Community 112 - "verify-academy.ts"
Cohesion: 0.08
Nodes (52): api(), apiReachable(), check(), cleanup(), d(), expectRejection(), HttpResult, Line (+44 more)

### Community 113 - "presentCanvass"
Cohesion: 0.70
Nodes (5): awardOf(), canvassRow(), figuresOf(), presentCanvass(), sheetLinesOf()

### Community 115 - "stockCardHistory.ts"
Cohesion: 0.20
Nodes (14): MOVE_KIND_LABELS, OdooMoveKind, counterparties(), historyOf(), HistoryRow, join(), MoveLike, MovementDocument (+6 more)

### Community 116 - "typedItemSplit.ts"
Cohesion: 0.38
Nodes (9): typedIdentity(), D(), fillTypedItemDescriptions(), num(), OrderLine, Skip, splitInside(), splitMergedTypedItems() (+1 more)

### Community 117 - "celebrations.ts"
Cohesion: 0.27
Nodes (11): annualDayIn(), Celebration, CelebrationKind, celebrationsBetween(), fillGreeting(), key(), manilaHour(), occurrencesBetween() (+3 more)

### Community 118 - "submitForApproval"
Cohesion: 0.15
Nodes (28): settle(), signCosting(), settle(), main(), assertRoutable(), tellIssuedTo(), tellReceived(), tellToConfirmAtSite() (+20 more)

### Community 121 - "commissions.ts"
Cohesion: 0.08
Nodes (34): assertMayDelete(), mayDeleteDocument(), checkSheet(), COMMISSION_LINK(), commissionListSummary(), commissionRoutes, D(), loadVisible() (+26 more)

### Community 122 - "team.ts"
Cohesion: 0.19
Nodes (14): fillOrderTeams(), fillQuotationTeams(), FIRST_INDUSTRY_SUCCESSOR, orderTeamWhere(), OWNER_TEAM_SELECT, quotationsReadable(), quotationTeamWhere(), salesOrdersReadable() (+6 more)

### Community 123 - "catalogue.ts"
Cohesion: 0.31
Nodes (10): clearPhoto(), dropPlaceholder(), oldPhotos(), PHOTO_MAX_PX, photoBytes(), placeOnShelf(), setPhoto(), syncCatalogue() (+2 more)

## Knowledge Gaps
- **7 isolated node(s):** `RFC-4180`, `RFC-4180`, `RFC-6266`, `RFC-2047`, `RFC-5545` (+2 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1471 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `prisma` connect `prisma.ts` to `salesReports.ts`, `masters.ts`, `shared/insights.ts`, `index.ts`, `rfq.ts`, `routes/hr.ts`, `resolve.ts`, `planApprovals.ts`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `pdf.ts`, `verify-plantilla.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `handler`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `statusLabel`, `odoo.ts`, `clearances.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `pdfTemplates.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `pdfDesign.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `env.ts`, `imports.ts`, `finAccess.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `verify-calendar.ts`, `audit.ts`, `verify-delivery.ts`, `roles.ts`, `day.ts`, `verify-meetings.ts`, `builkImport.ts`, `shared/finance.ts`, `kit.ts`, `lineCharges.ts`, `verify-chain.ts`, `routes/marketing.ts`, `paper.ts`, `stockMovements.ts`, `shared/chain.ts`, `evaluationRuns.ts`, `masters.ts`, `mail.ts`, `verify-insights-brief.ts`, `kit.ts`, `shared/holidays.ts`, `projectBudget.ts`, `workspace.ts`, `orgChart.ts`, `cadJobOrders.ts`, `plantilla.ts`, `quotation.ts`, `valueRevision`, `courseCategories.ts`, `pipelineStages.ts`, `receiptCost.ts`, `pdfAttachments.ts`, `inventory.ts`, `import-settings.ts`, `myRecords.ts`, `sales.ts`, `verify-hr.ts`, `verify-academy.ts`, `stockCardHistory.ts`, `typedItemSplit.ts`, `celebrations.ts`, `submitForApproval`, `commissions.ts`, `team.ts`, `catalogue.ts`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **What connects `RFC-4180`, `RFC-4180`, `RFC-6266` to the rest of the system?**
  _7 weakly-connected nodes found - possible missing edges._
- **Should `salesReports.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08181818181818182 - nodes in this community are weakly interconnected._
- **Why does `badRequest()` connect `badRequest` to `salesReports.ts`, `masters.ts`, `forecast.ts`, `shared/insights.ts`, `index.ts`, `rfq.ts`, `routes/hr.ts`, `resolve.ts`, `planApprovals.ts`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `handler`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `statusLabel`, `odoo.ts`, `notFound`, `clearances.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `idsFilter`, `pdfTemplates.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `liveness.ts`, `routes/meetings.ts`, `pullouts.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `imports.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `face.ts`, `verify-delivery.ts`, `day.ts`, `verify-meetings.ts`, `shared/finance.ts`, `kit.ts`, `lineCharges.ts`, `verify-chain.ts`, `routes/marketing.ts`, `evaluationRuns.ts`, `masters.ts`, `kit.ts`, `workspace.ts`, `cadJobOrders.ts`, `plantilla.ts`, `receiptCost.ts`, `inventory.ts`, `myRecords.ts`, `sales.ts`, `verify-academy.ts`, `submitForApproval`, `commissions.ts`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Should `masters.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05870020964360587 - nodes in this community are weakly interconnected._
- **Why does `@prisma/client` connect `env.ts` to `salesReports.ts`, `masters.ts`, `shared/insights.ts`, `index.ts`, `rfq.ts`, `routes/hr.ts`, `resolve.ts`, `planApprovals.ts`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `verify-plantilla.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `handler`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `odoo.ts`, `clearances.ts`, `verify-sales.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `prisma.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `imports.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `audit.ts`, `verify-delivery.ts`, `day.ts`, `builkImport.ts`, `shared/finance.ts`, `kit.ts`, `lineCharges.ts`, `verify-chain.ts`, `routes/marketing.ts`, `paper.ts`, `stockMovements.ts`, `shared/chain.ts`, `evaluationRuns.ts`, `masters.ts`, `dependencies`, `verify-insights-brief.ts`, `kit.ts`, `shared/holidays.ts`, `projectBudget.ts`, `workspace.ts`, `orgChart.ts`, `package.json`, `cadJobOrders.ts`, `plantilla.ts`, `quotation.ts`, `valueRevision`, `receiptCost.ts`, `inventory.ts`, `import-settings.ts`, `sales.ts`, `verify-hr.ts`, `verify-academy.ts`, `typedItemSplit.ts`, `celebrations.ts`, `submitForApproval`, `commissions.ts`, `team.ts`, `catalogue.ts`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Should `forecast.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07078039927404718 - nodes in this community are weakly interconnected._