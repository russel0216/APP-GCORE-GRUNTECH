# Graph Report - api  (2026-11-25)

## Corpus Check
- 258 files · ~1,052,748 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, .prisma 1)

## Summary
- 4781 nodes · 17596 edges · 132 communities (127 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 226 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d3265fa1`
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
- verify-plantilla.ts
- routes/finance.ts
- salesOrders.ts
- warehouse.ts
- routes/evaluations.ts
- routes/budgetRequests.ts
- routes/hiring.ts
- verify-accounts.ts
- employmentExams.ts
- routes/partners.ts
- routes/peopleFlow.ts
- procurement.ts
- verify-partners.ts
- odoo.ts
- notFound
- clearance.ts
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
- invoiceRequests.ts
- nextNumber
- badRequest
- mail.ts
- verify-hr.ts
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
- prisma.ts
- verify-delivery.ts
- roleSeeds.ts
- main
- verify-meetings.ts
- builkImport.ts
- manilaDayStart
- costingMath.ts
- canvassMath.ts
- kit.ts
- lineCharges.ts
- verify-chain.ts
- jobs.ts
- paper.ts
- stockMovements.ts
- shared/chain.ts
- recalc
- masters.ts
- mail.ts
- dependencies
- verify-insights-brief.ts
- memos.ts
- devDependencies
- shared/holidays.ts
- inventory.ts
- compilerOptions
- auth.ts
- workspace.ts
- orgChart.ts
- package.json
- scopePreload.ts
- cadJobOrders.ts
- orderStock.ts
- quotation.ts
- multer
- pdfkit
- imports/odooMoves.ts
- receiptCost.ts
- scripts
- @types/multer@^1.4.12
- typedItems.ts
- import-settings.ts
- sankey.ts
- verify-masters.ts
- registry.ts
- myRecords.ts
- activities.ts
- costingSets.ts
- shared/hiring.ts
- verify-academy.ts
- num
- present
- stockCardHistory.ts
- typedItemSplit.ts
- celebrations.ts
- submitForApproval
- seed-sample-quotation.ts
- officeBudgets.ts
- commission.ts
- team.ts
- catalogue.ts
- D
- viewScope
- chainAccess.ts
- presentContract
- compression
- @types/pdfkit@^0.13.9
- presentMpr
- subIndustries.ts

## God Nodes (most connected - your core abstractions)
1. `badRequest()` - 337 edges
2. `prisma` - 212 edges
3. `can()` - 176 edges
4. `audit()` - 173 edges
5. `notFound()` - 150 edges
6. `@prisma/client` - 140 edges
7. `nextNumber()` - 123 edges
8. `main()` - 112 edges
9. `idsFilter()` - 105 edges
10. `statusLabel()` - 102 edges

## Surprising Connections (you probably didn't know these)
- `signCosting()` --calls--> `act()`  [EXTRACTED]
  scripts/verify-costing.ts → src/shared/approvals.ts
- `cleanupOdoo()` --calls--> `deleteAttachmentsOf()`  [EXTRACTED]
  scripts/verify-chain.ts → src/shared/attachments.ts
- `cleanup()` --calls--> `deleteAttachment()`  [EXTRACTED]
  scripts/verify-chain.ts → src/shared/attachments.ts
- `main()` --calls--> `signToken()`  [EXTRACTED]
  scripts/verify-chain.ts → src/auth/middleware.ts
- `main()` --calls--> `resolveUser()`  [EXTRACTED]
  scripts/verify-chain.ts → src/permissions/resolve.ts

## Import Cycles
- 2-file cycle: `src/shared/gops.ts -> src/shared/insights.ts -> src/shared/gops.ts`
- 3-file cycle: `src/shared/gops.ts -> src/shared/reportKit.ts -> src/shared/insights.ts -> src/shared/gops.ts`
- 4-file cycle: `src/shared/chain.ts -> src/shared/finance.ts -> src/shared/inventory.ts -> src/shared/reorder.ts -> src/shared/chain.ts`

## Communities (132 total, 5 thin omitted)

### Community 0 - "statusLabel"
Cohesion: 0.07
Nodes (125): require_(), presentAdvance(), borrow(), canvass(), incoming(), inventory(), KINDS, outgoing() (+117 more)

### Community 1 - "masters.ts"
Cohesion: 0.04
Nodes (70): requireAny(), requireSuperAdmin(), conflict(), assertCodeFree(), templateCanEdit(), customerForEdit(), asDate(), assertLoginEmailFree() (+62 more)

### Community 2 - "sales.ts"
Cohesion: 0.03
Nodes (117): ACTIVITY_INCLUDE, activitySchema, asDate(), BREAKDOWN_WORD, breakdownOfQuery(), checkActivityLinks(), checkLine(), checkQuoteNumber() (+109 more)

### Community 3 - "shared/insights.ts"
Cohesion: 0.07
Nodes (62): check(), cleanup(), D(), day(), expectRejection(), main(), makeJob(), makeQuotation() (+54 more)

### Community 4 - "index.ts"
Cohesion: 0.03
Nodes (63): app, webDist, AUDIT_SORTS, auditClock, auditRoutes, auditWhen(), checkAlsoRoles(), checkPreparer() (+55 more)

### Community 5 - "kit.ts"
Cohesion: 0.05
Nodes (51): zod, assertMayDelete(), deleteOrRefuse(), handler(), ListQuery, ListResult, listResult(), MAX_SELECTED_IDS (+43 more)

### Community 6 - "routes/hr.ts"
Cohesion: 0.04
Nodes (71): allocateSchema, alreadyIn(), alreadyOut(), asDate(), ATTENDANCE_SORTS, capturedFrames(), capturedPhoto(), captureReader() (+63 more)

### Community 7 - "resolve.ts"
Cohesion: 0.05
Nodes (41): canView(), menuFor(), MenuModule, MenuSubmodule, CLOSED, createSchema, helpTicketRoutes, KIND_LABEL (+33 more)

### Community 8 - "can"
Cohesion: 0.06
Nodes (46): can(), assertTrainer(), mayReadPayment(), PaymentRegister, paymentRegister(), attendanceScoped(), filingRoute(), CLEARED_CUSTOMER (+38 more)

### Community 9 - "routes/academy.ts"
Cohesion: 0.03
Nodes (79): academySettingsRoutes, activeCourse(), addAttendeesSchema, asDate(), assertCanEdit(), assertCourseReadable(), CALENDAR_VIEW, cancelSchema (+71 more)

### Community 10 - "routes/aftermarket.ts"
Cohesion: 0.04
Nodes (58): asDate(), assertNoReportOnReplannedVisits(), assetInclude, assetListSummary(), AssetRow, assetSchema, ATTENDED, CLOSED_CONTRACT (+50 more)

### Community 11 - "jobs.ts"
Cohesion: 0.07
Nodes (44): RFC-6266, KIND_LABEL, jobFilterLine(), asDate(), checkBelongs(), include, isoDay(), load() (+36 more)

### Community 12 - "scoroInvoices.ts"
Cohesion: 0.07
Nodes (65): errorMiddleware(), HttpError, linkGone(), teamFor(), methodOf(), OwnerChoice, ownerChoices(), ownerKey() (+57 more)

### Community 13 - "verify-foundation.ts"
Cohesion: 0.03
Nodes (14): contentStreams(), shown(), winAnsi(), pageOf(), pdfEdges(), textAt(), CLEARED_MARK, OVERRIDES_DROPPED_MARK (+6 more)

### Community 14 - "pdf.ts"
Cohesion: 0.07
Nodes (60): isoKey(), isWorkingDay(), isWorkingDow(), Align, autoWidths(), breakPoint(), caps(), CellLine (+52 more)

### Community 15 - "verify-plantilla.ts"
Cohesion: 0.10
Nodes (40): pendingCount(), signoffSlots(), slotsSaid(), splittingValue(), CHART_KEYS, rolesLike(), apiReachable(), bells() (+32 more)

### Community 16 - "routes/finance.ts"
Cohesion: 0.03
Nodes (70): ALL_PAYMENTS, AMENDABLE, amendSchema, asDate(), awaitsApproval(), BILL_OWED, BILL_SORTS, BillBody (+62 more)

### Community 17 - "salesOrders.ts"
Cohesion: 0.05
Nodes (58): descriptionMemory(), breakdownSection(), changeWords(), comparedCells(), quotationListSummary(), quotationPrintData(), revisionsMargin(), toCents() (+50 more)

### Community 18 - "warehouse.ts"
Cohesion: 0.05
Nodes (86): itemListWhere(), activeGroupNames(), asDate(), assertStockVisible(), BORROW_SORTS, BORROW_TYPES, borrowLineSchema, borrowSheetSchema (+78 more)

### Community 19 - "routes/evaluations.ts"
Cohesion: 0.08
Nodes (57): api(), apiReachable(), check(), cleanup(), expectRejection(), HttpResult, iso(), Line (+49 more)

### Community 20 - "routes/budgetRequests.ts"
Cohesion: 0.04
Nodes (62): APPROVED_STATES, asDate(), assertCanOpen(), assertCanSee(), BOOKABLE, bookSchema, BUDGET_LIST_PERMISSIONS, budgetRequestListWhere() (+54 more)

### Community 21 - "routes/hiring.ts"
Cohesion: 0.05
Nodes (33): CANDIDATE_SORTS, candidateInclude, CandidateRow, candidateSchema, checkContractDates(), checkMprRefs(), checkOpenMpr(), CONTRACT_EDIT_RIGHTS (+25 more)

### Community 22 - "verify-accounts.ts"
Cohesion: 0.16
Nodes (17): ADMIN_RESET_HOURS, createLogin(), deliverLink(), Delivery, escapeHtml(), hashToken(), INVITE_DAYS, issueToken() (+9 more)

### Community 23 - "employmentExams.ts"
Cohesion: 0.14
Nodes (19): answersSchema, brake(), dayKey(), EXAM_READERS, examQuestionRoutes, finalize(), __forTests, hashOf() (+11 more)

### Community 24 - "routes/partners.ts"
Cohesion: 0.08
Nodes (32): orderBy(), detailFor(), PARTNER_SORTS, partnerForEdit(), partnerListWhere(), partnerOr404(), partnerPatchSchema, partnerRoutes (+24 more)

### Community 25 - "routes/peopleFlow.ts"
Cohesion: 0.07
Nodes (53): baseWhere(), flowRows(), fullName(), itemBody, matches(), pathResponse(), present(), readable() (+45 more)

### Community 26 - "procurement.ts"
Cohesion: 0.04
Nodes (44): asDate(), assertCanvassVisible(), AwardSupplier, CANVASS_SORTS, canvassView(), CheckedPrLine, checkNature(), checkPoLines() (+36 more)

### Community 27 - "verify-partners.ts"
Cohesion: 0.15
Nodes (27): apiReachable(), check(), cleanup(), http(), httpCases(), HttpResult, main(), makeRole() (+19 more)

### Community 28 - "odoo.ts"
Cohesion: 0.08
Nodes (45): odooMigration(), activeEmployees(), buildAsset(), buildInventory(), cents(), chunks(), COLUMNS, D() (+37 more)

### Community 29 - "notFound"
Cohesion: 0.05
Nodes (78): currentUser(), badRequest(), forbidden(), notFound(), canEditRecord(), onReportReopened(), forEdit(), load() (+70 more)

### Community 30 - "clearance.ts"
Cohesion: 0.12
Nodes (26): redact(), AccountabilityRef, AREA_ORDER, ChecklistLine, CLEARANCE_AREAS, ClearanceSummary, clearanceSummary(), figuresFor() (+18 more)

### Community 31 - "exhibitionVisitors.ts"
Cohesion: 0.08
Nodes (46): apiReachable(), check(), cleanup(), http(), main(), makeUser(), ALIASES, Brand (+38 more)

### Community 32 - "verify-sales.ts"
Cohesion: 0.07
Nodes (42): apiReachable(), approvedBy(), asApproved(), check(), cleanup(), d(), editorTokenIsSpare(), http() (+34 more)

### Community 33 - "idsFilter"
Cohesion: 0.09
Nodes (47): idsFilter(), passportRows(), sessionListWhere(), advanceListWhere(), assertCanSee(), ownOnly(), assetListWhere(), contractListWhere() (+39 more)

### Community 34 - "pdfTemplates.ts"
Cohesion: 0.08
Nodes (45): DOCS, documentType(), pdfTemplateRoutes, previewSchema, TemplateDoc, PrintableSalesOrder, COSTING_COLUMN_LABELS, COSTING_COLUMNS (+37 more)

### Community 35 - "pipeline.ts"
Cohesion: 0.04
Nodes (75): loadBoard(), allowedTargets(), assertOutcomeChange(), BOARD_COLUMNS, BoardColumn, BoardColumnOut, BoardKpis, BoardLead (+67 more)

### Community 36 - "dayKey"
Cohesion: 0.11
Nodes (29): adminToken(), holidaysAside(), holidaysBack(), putHolidays(), pdfPieces(), api(), apiReachable(), check() (+21 more)

### Community 37 - "approvals.ts"
Cohesion: 0.08
Nodes (38): TYPICAL_REQUESTER, mayReleaseOrder(), ActInput, agreedOn(), APPROVAL_SIGNOFF, ApprovalContext, Contact, CONTACT_SELECT (+30 more)

### Community 38 - "jobOrders.ts"
Cohesion: 0.10
Nodes (37): agreedAmount(), asDate(), checkBelongs(), costingLabor(), crewOf(), IN_PROGRESS_WHERE, isoDay(), JOB_ORDER_SORTS (+29 more)

### Community 39 - "progress.ts"
Cohesion: 0.07
Nodes (33): asDate(), BILLING_COUNTED, BILLING_SORTS, billingListInclude, billingPreparer(), billingRoutes, billingTrail(), cents() (+25 more)

### Community 40 - "pdfDesign.ts"
Cohesion: 0.06
Nodes (41): checkedDesign(), columnLabel(), letterheadLines(), websiteForPrint(), ALIGNS, ANCHORS, base, boxBlock (+33 more)

### Community 41 - "seed.ts"
Cohesion: 0.07
Nodes (62): main(), prisma, SeedStep, WORKFLOWS, WorkflowSeed, allPermissions(), splitBorrowedRights(), seedActivityTypes() (+54 more)

### Community 42 - "shared/hr.ts"
Cohesion: 0.07
Nodes (46): start(), connectDb(), startActivityReminders(), accountPhotoFrom(), faceEngineReady(), FACE_ENGINE, deletePhotoIfUnused(), describeRefusalReason() (+38 more)

### Community 43 - "invoiceRequests.ts"
Cohesion: 0.05
Nodes (89): requireAnyOrDecider(), advanceListSummary(), availableAfterFor(), budgetRequestListSummary(), financePartOf(), recordOrProjectBudget(), requestBudget(), checkSheet() (+81 more)

### Community 44 - "nextNumber"
Cohesion: 0.11
Nodes (39): api(), apiReachable(), check(), cleanup(), expectRejection(), HOUSE, HttpResult, issueOf() (+31 more)

### Community 45 - "badRequest"
Cohesion: 0.20
Nodes (23): assertBudgetLeft(), auditOn(), budgetLineFor(), BUYABLE, cents(), costsToReallocate(), D(), handOverToProject() (+15 more)

### Community 46 - "mail.ts"
Cohesion: 0.11
Nodes (18): RFC-2047, intoQueue(), linkOf(), settleCadJobOrder(), tell(), tell(), tell(), base64Lines() (+10 more)

### Community 47 - "verify-hr.ts"
Cohesion: 0.05
Nodes (86): sharp, Box, eyesShut(), frameOf(), shearFrames(), stillFrames(), turnFrames(), api() (+78 more)

### Community 48 - "routes/meetings.ts"
Cohesion: 0.08
Nodes (25): addInviteesSchema, agreeSchema, cancelSchema, clockFmt, dateTimeFmt, detailSelect, invitableUsers(), inviteeIds (+17 more)

### Community 49 - "pullouts.ts"
Cohesion: 0.09
Nodes (33): asDate(), cents(), checkSheet(), D(), lineSchema, LIST_INCLUDE, listWhere(), LoadedSlip (+25 more)

### Community 50 - "verify-finance.ts"
Cohesion: 0.10
Nodes (47): hasLine(), labelsSaid(), approvedByCount(), cents(), check(), cleanup(), D(), expectRejection() (+39 more)

### Community 51 - "attendanceCorrections.ts"
Cohesion: 0.09
Nodes (31): at(), attendanceCorrectionWork(), body, checkDay(), correctedTimes(), CORRECTION_LINK(), EDIT_KEYS, include (+23 more)

### Community 52 - "Renderer"
Cohesion: 0.15
Nodes (14): formatDateTime(), pdfSafe(), safeSection(), safeSpec(), byPosition(), drawLaid(), fontName(), isAbove() (+6 more)

### Community 53 - "advances.ts"
Cohesion: 0.06
Nodes (41): ADVANCE_CLOSED, ADVANCE_SORTS, advanceInclude, advanceRoutes, AdvanceRow, advanceSchema, advanceStage(), asDate() (+33 more)

### Community 54 - "routes/assets.ts"
Cohesion: 0.08
Nodes (28): assetRoutes, checkType(), detailsOf(), include, LEAVING, loadSlip(), mayReadSlip(), nameOf() (+20 more)

### Community 55 - "costing.ts"
Cohesion: 0.07
Nodes (34): approvalConfigured(), assertCostingVisible(), assignSchema, categoryRanks(), checkReferences(), checkVatRate(), COSTING_SORTS, costingPaper() (+26 more)

### Community 56 - "env.ts"
Cohesion: 0.10
Nodes (26): bcryptjs, between(), pdfText(), clearing, create(), D(), ITEMS, PEOPLE (+18 more)

### Community 57 - "imports.ts"
Cohesion: 0.07
Nodes (34): courseImport, customerSpec, EmployeeImportRecord, employeesImport, employeeSpec, EMPLOYMENT_TYPES, importRoutes, ITEM_TYPES (+26 more)

### Community 58 - "finAccess.ts"
Cohesion: 0.20
Nodes (8): FIN_ACCESS_MARK, FIN_COMMON, FIN_MANAGER_ROLE, FIN_SALES, FIN_SALES_ROLES, MONEY_IN_ACCESS_MARK, MONEY_IN_KEYS, MONEY_IN_ROLES

### Community 59 - "officeBudget.ts"
Cohesion: 0.09
Nodes (38): PlaceCard, advanceOffice(), ASKED, billOffice(), cents(), chargeAgainstOffice(), claimOffice(), LINE_ORDER (+30 more)

### Community 60 - "verify-aftermarket.ts"
Cohesion: 0.09
Nodes (39): squash(), check(), cleanup(), D(), day(), expectRejection(), grantKeys(), iso() (+31 more)

### Community 61 - "face.ts"
Cohesion: 0.11
Nodes (21): AVATAR_PX, centre(), describe(), detect(), eyeGeometry(), FaceCapture, FaceLandmarks, FacePurpose (+13 more)

### Community 62 - "verify-calendar.ts"
Cohesion: 0.09
Nodes (10): apiGet(), apiReachable(), apiSend(), check(), cleanup(), main(), makeRole(), makeUser() (+2 more)

### Community 63 - "prisma.ts"
Cohesion: 0.06
Nodes (31): @prisma/client, prisma, AuditAction, AuditInput, ipOf(), REDACTED, CAD_DRAWING_TYPES, backfillCustomerAddresses() (+23 more)

### Community 64 - "verify-delivery.ts"
Cohesion: 0.16
Nodes (18): signedCount(), apiReachable(), check(), cleanup(), d(), http(), HttpResult, iso() (+10 more)

### Community 65 - "roleSeeds.ts"
Cohesion: 0.25
Nodes (6): ACCESS_SPLIT, FIRST_RUN, PROJECT_MANAGER_GRANTS, PROJECT_MANAGER_ONLY, ROLE_SEEDS, RoleSeed

### Community 66 - "main"
Cohesion: 0.11
Nodes (23): runWidth(), check(), cleanup(), expectRejection(), main(), restoreArchiveMark(), restoreTagline(), signoffOverruns() (+15 more)

### Community 67 - "verify-meetings.ts"
Cohesion: 0.10
Nodes (45): checkListPaper(), checkOwnPaper(), flat(), get(), printed(), readScreen(), referenceOf(), saysCount() (+37 more)

### Community 68 - "builkImport.ts"
Cohesion: 0.07
Nodes (52): main(), check(), fold(), main(), check(), fold(), main(), check() (+44 more)

### Community 69 - "manilaDayStart"
Cohesion: 0.19
Nodes (20): auditListWhere(), commissionListWhere(), paymentListWhere(), ticketListWhere(), attendanceListWhere(), missingClockOutWhere(), requestListWhere(), allDayStart() (+12 more)

### Community 70 - "costingMath.ts"
Cohesion: 0.13
Nodes (24): cents(), CostingFigures, costingFigures(), CostingRates, lineAmount(), lineAmountCents(), MathLine, MILLION (+16 more)

### Community 71 - "canvassMath.ts"
Cohesion: 0.23
Nodes (12): AwardSummary, awardSummary(), AwardWinner, canvassFigures(), ColumnFigures, lineAmountCents(), lowestPerLine(), MAX_SHEET_SUPPLIERS (+4 more)

### Community 72 - "kit.ts"
Cohesion: 0.08
Nodes (26): express, unauthorized(), activeSubIndustry(), activeTeam(), CONTACT_HOLDERS, contactSchema, Counted, customerListWhere() (+18 more)

### Community 73 - "lineCharges.ts"
Cohesion: 0.09
Nodes (37): requestCharging(), standInCategory(), claimCharges(), cents(), Db, num(), requestGroups(), requestPlaces() (+29 more)

### Community 74 - "verify-chain.ts"
Cohesion: 0.10
Nodes (40): names(), api(), apiReachable(), approvalSlot(), approvedBy(), approvedByCount(), awaits(), check() (+32 more)

### Community 75 - "jobs.ts"
Cohesion: 0.09
Nodes (29): asDate(), budgetPosition(), CategoryPosition, cents(), costingForJob(), costingsForJob(), createJobRecord(), createJobSchema (+21 more)

### Community 76 - "paper.ts"
Cohesion: 0.07
Nodes (42): pdf-lib@^1.17.1, pdf-lib, Clash, KINDS, main(), overlaps(), Row, Check (+34 more)

### Community 77 - "stockMovements.ts"
Cohesion: 0.13
Nodes (22): cents(), DIRECTIONS, DOCUMENT_KINDS, DocumentKind, DOCUMENTS, ITEM_SELECT, itemSearch(), itemWhere() (+14 more)

### Community 78 - "shared/chain.ts"
Cohesion: 0.15
Nodes (23): chainRoutes, usersInRole(), availableOf(), belowReorder(), ChainOverview, chainOverview(), itemsOnOrder(), num() (+15 more)

### Community 79 - "recalc"
Cohesion: 0.24
Nodes (10): asDay(), d(), headerData(), num(), ratesOf(), recalc(), settleCosting(), spreadSections() (+2 more)

### Community 80 - "masters.ts"
Cohesion: 0.05
Nodes (37): activityTypeSchema, AWAITING_PO, checkLevels(), costCategorySchema, courseCategorySchema, documentCategorySchema, drawingTypeSchema, editCategory (+29 more)

### Community 81 - "mail.ts"
Cohesion: 0.20
Nodes (18): apiReachable(), Captured, check(), cleanup(), decodedParts(), fakeSmtp(), fieldsOf(), http() (+10 more)

### Community 82 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, bcryptjs@^2.4.3, cors@^2.8.5, dotenv@^16.4.7, express@^4.21.2, helmet@^8.0.0, jsonwebtoken@^9.0.2, @prisma/client@^6.19.3 (+12 more)

### Community 83 - "verify-insights-brief.ts"
Cohesion: 0.18
Nodes (19): check(), cleanup(), D(), fig(), Figure, Line, main(), quotation() (+11 more)

### Community 84 - "memos.ts"
Cohesion: 0.10
Nodes (19): AUDIENCES, audienceSchema, checkedAudience(), day(), include, isRecipient(), load(), memoRoutes (+11 more)

### Community 85 - "devDependencies"
Cohesion: 0.11
Nodes (19): devDependencies, tsx@^4.19.2, @types/bcryptjs@^2.4.6, @types/compression@^1.7.5, @types/cors@^2.8.17, @types/express@^4.17.21, @types/jsonwebtoken@^9.0.7, @types/morgan@^1.9.9 (+11 more)

### Community 86 - "shared/holidays.ts"
Cohesion: 0.20
Nodes (17): holidayRoutes, schema, setHolidayKeys(), clean(), easter(), Holiday, HolidayKind, holidays() (+9 more)

### Community 87 - "inventory.ts"
Cohesion: 0.20
Nodes (22): dropPlaceholder(), applyDeclaredValueRule(), cents(), num(), availableBudget(), borrowStock(), cents(), D() (+14 more)

### Community 88 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 89 - "auth.ts"
Cohesion: 0.11
Nodes (16): authRoutes, changePasswordSchema, dayOf(), FACTS_SELECT, forgotSchema, loginSchema, newPassword, Personal (+8 more)

### Community 90 - "workspace.ts"
Cohesion: 0.05
Nodes (60): authenticate(), bearer(), Express, Request, TokenPayload, env, ResolvedUser, evaluationRunRoutes (+52 more)

### Community 91 - "orgChart.ts"
Cohesion: 0.08
Nodes (34): main(), main(), syncLoginFromEmployee(), applyEmployeeNumberList(), EMPLOYEE_NUMBER_LIST, fold(), NumberChange, NUMBERS_FROM_LIST_MARK (+26 more)

### Community 92 - "package.json"
Cohesion: 0.17
Nodes (11): morgan@^1.10.0, description, prisma@^6.19.3, main, name, prisma, seed, private (+3 more)

### Community 93 - "scopePreload.ts"
Cohesion: 0.40
Nodes (3): PreloadPhase, SCOPE_PRELOAD, ScopeKind

### Community 94 - "cadJobOrders.ts"
Cohesion: 0.08
Nodes (33): impliedBy(), asDate(), BEFORE_QUEUE, cadInclude, cadJobOrderRoutes, cadListWhere(), CadRow, cadSchema (+25 more)

### Community 95 - "orderStock.ts"
Cohesion: 0.24
Nodes (14): orderPurchasing(), RATE_SELECT, cents(), D(), issueOrderStock(), key(), num(), OrderMove (+6 more)

### Community 96 - "quotation.ts"
Cohesion: 0.07
Nodes (38): presentRevision(), canSeeQuotationCost(), CostingForQuote, costingsForQuote(), costingSplit(), CostPanel, D(), DEFAULT_QUOTATION_CURRENCY (+30 more)

### Community 99 - "imports/odooMoves.ts"
Cohesion: 0.11
Nodes (34): assetRef(), partNumbers(), build(), COLUMNS, D(), itemFor(), odooMovesImport, OdooMovesRecord (+26 more)

### Community 100 - "receiptCost.ts"
Cohesion: 0.19
Nodes (19): awardedCanvass(), presentPo(), BASE_CURRENCY, basisWords(), centavo(), CostBasis, CostedLine, CostedOrder (+11 more)

### Community 101 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, prisma:deploy, prisma:generate, prisma:migrate, prisma:push, prisma:studio (+3 more)

### Community 103 - "typedItems.ts"
Cohesion: 0.14
Nodes (22): check(), main(), Rollback, backfillProjectStock(), cents(), D(), issueProjectStock(), key() (+14 more)

### Community 104 - "import-settings.ts"
Cohesion: 0.20
Nodes (12): isBookkeeping(), main(), SNAPSHOT_VERSION, main(), same(), Snapshot, picturesFor(), attachmentPath() (+4 more)

### Community 105 - "sankey.ts"
Cohesion: 0.22
Nodes (8): SalesReportSpec, layoutSankey(), SankeyInput, SankeyLayout, SankeyLink, SankeyNode, share(), topOfFlow()

### Community 106 - "verify-masters.ts"
Cohesion: 0.25
Nodes (15): check(), cleanup(), main(), customerListSummary(), customerWrite(), supplierListSummary(), supplierListWhere(), decodeCsv() (+7 more)

### Community 107 - "registry.ts"
Cohesion: 0.12
Nodes (15): Action, ACTION_LABELS, ACTIONS, findSubmodule(), ModuleDef, OWNED, OWNED_KEPT, PermissionDef (+7 more)

### Community 108 - "myRecords.ts"
Cohesion: 0.12
Nodes (23): myRecordsRoutes, seedChecklist(), leaveBalance(), Cutoff, CUTOFF_DEFAULT, cutoffByKey(), cutoffFor(), CutoffRule (+15 more)

### Community 109 - "activities.ts"
Cohesion: 0.16
Nodes (16): mayChangeActivity(), activityEmailText(), activityLink(), ActivityQuery, activityWhen(), addMonthsManila(), isOnActivity(), maskPrivate() (+8 more)

### Community 110 - "costingSets.ts"
Cohesion: 0.17
Nodes (14): assertCostingsExist(), cleanCostingIds(), COSTING_SCOPES, costingIdsOf(), CostingScope, CostingScopes, costingScopesOf(), jobCostingIds() (+6 more)

### Community 111 - "shared/hiring.ts"
Cohesion: 0.19
Nodes (12): mayEditCandidate(), presentCandidate(), scoreOf(), CANDIDATE_CLOSED, CANDIDATE_FLOW, CandidateStatusKey, ENTRANCE_EXAMS, examPct() (+4 more)

### Community 112 - "verify-academy.ts"
Cohesion: 0.08
Nodes (49): api(), apiReachable(), check(), cleanup(), d(), expectRejection(), HttpResult, Line (+41 more)

### Community 113 - "num"
Cohesion: 0.20
Nodes (16): awardOf(), batchSource(), canvassRow(), figuresOf(), forLabelOf(), fromRequestItem(), lineSuggestions(), mayEditCanvass() (+8 more)

### Community 114 - "present"
Cohesion: 0.50
Nodes (4): dayKey(), present(), round2(), lineCodes()

### Community 115 - "stockCardHistory.ts"
Cohesion: 0.20
Nodes (13): borrowListWhere(), mineWhere(), MOVE_KIND_LABELS, OdooMoveKind, counterparties(), join(), MoveLike, MovementDocument (+5 more)

### Community 116 - "typedItemSplit.ts"
Cohesion: 0.38
Nodes (9): typedIdentity(), D(), fillTypedItemDescriptions(), num(), OrderLine, Skip, splitInside(), splitMergedTypedItems() (+1 more)

### Community 117 - "celebrations.ts"
Cohesion: 0.27
Nodes (11): annualDayIn(), Celebration, CelebrationKind, celebrationsBetween(), fillGreeting(), key(), manilaHour(), occurrencesBetween() (+3 more)

### Community 118 - "submitForApproval"
Cohesion: 0.17
Nodes (24): settle(), settle(), routeSignoffs(), routeSignoffs(), unroutedOrderSignoff(), act(), approvalSlots(), approversForStep() (+16 more)

### Community 119 - "seed-sample-quotation.ts"
Cohesion: 0.27
Nodes (10): d(), deleteStray(), ISSUED, LINES, main(), ORDER_DESCRIPTIONS, ORDERS, pickOwner() (+2 more)

### Community 120 - "officeBudgets.ts"
Cohesion: 0.17
Nodes (12): assertNameFree(), cents(), checkCodes(), createSchema, D(), lineSchema, mayChange(), officeBudgetRoutes (+4 more)

### Community 121 - "commission.ts"
Cohesion: 0.33
Nodes (8): CommissionFigures, commissionFigures(), CommissionInput, CommissionShareInput, mulRate(), pesos(), toCents(), toMicro()

### Community 122 - "team.ts"
Cohesion: 0.33
Nodes (8): fillOrderTeams(), fillQuotationTeams(), FIRST_INDUSTRY_SUCCESSOR, quotationsReadable(), quotationTeamWhere(), Team, teamMembers(), TEAMS

### Community 123 - "catalogue.ts"
Cohesion: 0.27
Nodes (12): odooPicturesWrite(), deleteAttachment(), saveAttachmentBytes(), clearPhoto(), oldPhotos(), PHOTO_MAX_PX, photoBytes(), placeOnShelf() (+4 more)

### Community 124 - "D"
Cohesion: 0.33
Nodes (7): cents(), D(), poVat(), recalcPo(), receivedPct(), writePoLines(), writePrLines()

### Community 125 - "viewScope"
Cohesion: 0.33
Nodes (7): loadCandidate(), assertOrderVisible(), printableSalesOrder(), salesOrderListWhere(), viewScope(), readsSalesOrder(), salesOrdersReadable()

### Community 126 - "chainAccess.ts"
Cohesion: 0.29
Nodes (5): CHAIN_ACCESS_MARK, CHAIN_COMMON, CHAIN_MANAGER_ROLES, CHAIN_PR, CHAIN_PR_ROLES

### Community 127 - "presentContract"
Cohesion: 0.50
Nodes (4): contractRoute(), mayEditContract(), nameOf(), presentContract()

### Community 130 - "presentMpr"
Cohesion: 0.50
Nodes (4): mayEditMpr(), mprFigures(), num(), presentMpr()

### Community 131 - "subIndustries.ts"
Cohesion: 0.50
Nodes (3): RENAMED, RETIRED, SUB_INDUSTRIES

## Knowledge Gaps
- **7 isolated node(s):** `RFC-6266`, `RFC-4180`, `RFC-4180`, `RFC-5545`, `RFC-4180` (+2 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1451 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `badRequest()` connect `notFound` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `employmentExams.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `verify-partners.ts`, `odoo.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `idsFilter`, `pdfTemplates.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `pdfDesign.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `verify-hr.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `imports.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `face.ts`, `verify-meetings.ts`, `manilaDayStart`, `kit.ts`, `lineCharges.ts`, `jobs.ts`, `recalc`, `masters.ts`, `verify-insights-brief.ts`, `memos.ts`, `inventory.ts`, `auth.ts`, `workspace.ts`, `cadJobOrders.ts`, `orderStock.ts`, `imports/odooMoves.ts`, `typedItems.ts`, `import-settings.ts`, `verify-masters.ts`, `myRecords.ts`, `activities.ts`, `costingSets.ts`, `verify-academy.ts`, `num`, `submitForApproval`, `officeBudgets.ts`, `catalogue.ts`, `viewScope`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **What connects `RFC-6266`, `RFC-4180`, `RFC-4180` to the rest of the system?**
  _7 weakly-connected nodes found - possible missing edges._
- **Should `statusLabel` be split into smaller, more focused modules?**
  _Cohesion score 0.0659041394335512 - nodes in this community are weakly interconnected._
- **Why does `prisma` connect `prisma.ts` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `pdf.ts`, `verify-plantilla.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `employmentExams.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `verify-partners.ts`, `odoo.ts`, `notFound`, `clearance.ts`, `exhibitionVisitors.ts`, `verify-sales.ts`, `pdfTemplates.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `pdfDesign.ts`, `seed.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `verify-hr.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `env.ts`, `imports.ts`, `finAccess.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `verify-calendar.ts`, `verify-delivery.ts`, `roleSeeds.ts`, `verify-meetings.ts`, `builkImport.ts`, `kit.ts`, `lineCharges.ts`, `verify-chain.ts`, `jobs.ts`, `paper.ts`, `stockMovements.ts`, `shared/chain.ts`, `masters.ts`, `mail.ts`, `verify-insights-brief.ts`, `memos.ts`, `shared/holidays.ts`, `inventory.ts`, `auth.ts`, `workspace.ts`, `orgChart.ts`, `cadJobOrders.ts`, `orderStock.ts`, `quotation.ts`, `imports/odooMoves.ts`, `receiptCost.ts`, `typedItems.ts`, `import-settings.ts`, `verify-masters.ts`, `myRecords.ts`, `activities.ts`, `costingSets.ts`, `shared/hiring.ts`, `verify-academy.ts`, `stockCardHistory.ts`, `typedItemSplit.ts`, `celebrations.ts`, `seed-sample-quotation.ts`, `officeBudgets.ts`, `team.ts`, `catalogue.ts`, `chainAccess.ts`, `subIndustries.ts`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Should `masters.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.04044750430292599 - nodes in this community are weakly interconnected._
- **Why does `@prisma/client` connect `prisma.ts` to `statusLabel`, `masters.ts`, `sales.ts`, `shared/insights.ts`, `index.ts`, `kit.ts`, `routes/hr.ts`, `resolve.ts`, `can`, `routes/academy.ts`, `routes/aftermarket.ts`, `jobs.ts`, `scoroInvoices.ts`, `verify-foundation.ts`, `verify-plantilla.ts`, `routes/finance.ts`, `salesOrders.ts`, `warehouse.ts`, `routes/evaluations.ts`, `routes/budgetRequests.ts`, `routes/hiring.ts`, `verify-accounts.ts`, `employmentExams.ts`, `routes/partners.ts`, `routes/peopleFlow.ts`, `procurement.ts`, `verify-partners.ts`, `odoo.ts`, `notFound`, `clearance.ts`, `verify-sales.ts`, `pipeline.ts`, `dayKey`, `approvals.ts`, `jobOrders.ts`, `progress.ts`, `seed.ts`, `shared/hr.ts`, `invoiceRequests.ts`, `nextNumber`, `badRequest`, `verify-hr.ts`, `routes/meetings.ts`, `pullouts.ts`, `verify-finance.ts`, `attendanceCorrections.ts`, `advances.ts`, `routes/assets.ts`, `costing.ts`, `env.ts`, `imports.ts`, `officeBudget.ts`, `verify-aftermarket.ts`, `verify-delivery.ts`, `verify-meetings.ts`, `builkImport.ts`, `kit.ts`, `lineCharges.ts`, `verify-chain.ts`, `jobs.ts`, `paper.ts`, `stockMovements.ts`, `shared/chain.ts`, `masters.ts`, `dependencies`, `verify-insights-brief.ts`, `memos.ts`, `shared/holidays.ts`, `inventory.ts`, `auth.ts`, `workspace.ts`, `orgChart.ts`, `package.json`, `cadJobOrders.ts`, `orderStock.ts`, `quotation.ts`, `imports/odooMoves.ts`, `receiptCost.ts`, `typedItems.ts`, `import-settings.ts`, `activities.ts`, `costingSets.ts`, `verify-academy.ts`, `typedItemSplit.ts`, `celebrations.ts`, `seed-sample-quotation.ts`, `officeBudgets.ts`, `team.ts`, `catalogue.ts`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Should `sales.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.02963545764489903 - nodes in this community are weakly interconnected._