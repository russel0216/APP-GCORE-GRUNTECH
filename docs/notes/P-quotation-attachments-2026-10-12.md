# Plan — attachments on the quotation and the sales order, printed with the paper (2026-10-12)

The owner's words: "On quotation, add attachment card between sales order and
activity. They can attach picture, pdf or any document related to the
quotation, e.g. Purchase Order. When print or save as, the quotation also
includes the attached documents. When created as sales order, the attachment
also transfers, so the complete approval of the sales order prints with the
attached documents. The attachment card sits at the bottom of the sales
order. Correct also the spacing of the approval card and the order card."

Status: **planned, not built.**

## What is there today

- `components/Attachments.tsx` is the one attachments card (upload, list,
  open through `openAttachment()`, remove); it takes any `entityType` /
  `entityId`. Files are `Attachment` rows (`fileName`, `storedName`,
  `mimeType`, `size`, `caption`) on disk under `env.uploadDir`; the generic
  routes accept images, PDF, Office documents, CSV, text, zip and CAD
  formats. `registerAttachmentGuard(entityType, guard)` applies a record's
  own visibility to its files (the expense claim's, the CAD J.O.'s, the
  help ticket's); a type with no guard is open to any login.
- Neither the quotation nor the sales order has a card. The CAD J.O.'s
  "file as Approved Plan" already COPIES files from one record to another
  (bytes copied, a new row, a caption saying where from) — the rule to
  reuse.
- The papers come from `renderDesigned()` (pdfkit). pdfkit can place a
  JPEG or PNG but cannot read another PDF, so "print with the attached
  documents" needs a PDF merger. **`pdf-lib` (1.17.1, pure JavaScript, no
  native build)** is the one dependency this plan adds — copying pages
  out of an uploaded PDF and in after the document's own pages.
- The sales order page draws its Order / Released-by grid straight under
  the Approval card with no `sales-card-gap`, which is the uneven spacing
  in the owner's screenshot (the "Per …" note and the Approval card have
  the gap; the grid does not).

## 1. The cards

- **Quotation page**: `<Attachments entityType="quotation" entityId=…>`
  between the Sales orders card and the Activity card, in the
  `sales-card-gap` dress; title "Attachments", hint "A purchase order, a
  drawing, a photo — printed after the quotation". The attachments belong
  to the QUOTATION, not a revision: a new revision keeps them.
- **Sales order page**: the same card last, under the Lines card (the
  owner's place). An issued or cancelled order still takes files (a PO
  arrives after booking) — adding a file never changes the record.
- **Guards**: `registerAttachmentGuard('quotation', …)` lets in whoever
  may read the quotation (`quotationListWhere`'s visibility, the record
  route's own test) and, for writing, whoever may edit it OR holds
  `gops.sales_orders.create` (sales files the PO on a quotation they did
  not raise); `registerAttachmentGuard('sales_order', …)` the order's
  rule. A stand-in deciding the order (rule of 2026-10-12) reads through
  `mayDecide()` too. Deleting a quotation or purging it removes its files
  (`deleteAttachmentsOf`); the sales order's delete the same.

## 2. Printing with the attachments

`withAttachments(pdf: Buffer, files: Attachment[])` in
`shared/pdfAttachments.ts`, applied by `GET /quotations/:id/revisions/:rid/
pdf` and `GET /sales-orders/:id/pdf` (not by the list papers, the preview
in Admin › PDF Templates, nor the specimen):

- The document's own pages first, unchanged.
- Then, in upload order, each attachment it can show: a **PDF** has its
  pages copied in whole (through `pdf-lib`; a PDF it cannot parse —
  encrypted, broken — is listed, not printed); an **image** (JPEG, PNG;
  WEBP and GIF converted to PNG through `sharp`, which the face engine
  already carries) is placed on an A4 page of its own, fitted inside the
  36pt margins and never enlarged past its pixels, the file name as a
  caption line under it.
- Every other file (Word, Excel, CSV, zip, CAD) cannot be drawn: an
  **"Attachments" page** in the house dress lists every attached file —
  name, size, uploaded by and when, "printed on the following pages" or
  "not printable — open it in G-CORE" — printed ONLY when there is at
  least one attachment; a quotation with none prints as today. The page
  comes before the copied files, so the reader knows what follows.
- "Page n of m" on the document's own pages keeps the document's own
  count: the attachments are appendices, each keeping its own numbering,
  as a PO photocopied behind a quotation would. The Attachments page says
  how many pages follow.
- `?attachments=0` prints the bare document (the PDF button's menu offers
  "Print without attachments"); the default includes them, as the owner
  asked. The list's PDF column prints the bare document.
- The audit row (EXPORTED) names how many attachments went with it.

## 3. The sales order takes the quotation's files

`POST /sales-orders` copies every attachment of the quotation onto the new
order — bytes copied, new rows captioned "From quotation <number>" (the CAD
plan's rule) — after the order's transaction commits; a copy that fails
leaves the order standing and is logged. A later file added to the
quotation does NOT follow (the order was booked with what was there); it
is added to the order by hand. The order's paper prints its own files, so
the approvers' copy carries the PO. Deleting a copy on the order never
touches the quotation's original.

## 4. Spacing

The Order / Released-by grid on the sales order page takes
`sales-card-gap`, so Approval › Order › Lines › Attachments are evenly
spaced; verify-foundation does not pin CSS, a screenshot proves it.

## Verify

- **verify-sales** (HTTP): upload a PNG and a two-page PDF on a quotation
  (the generic route, as a salesperson); its paper has the document's
  pages + 1 (the Attachments page) + 1 (the image) + 2; the Attachments
  page names both files; `?attachments=0` is the bare count; a reader who
  may not open the quotation gets 403 on its files; creating an order
  copies both (two new rows, captions, bytes equal, distinct storedName);
  the order's paper carries them; deleting the order's copy leaves the
  quotation's; a Word file is listed as not printable; a broken PDF is
  listed, not merged, and the paper still renders. Cleanup deletes the
  files on disk (verify-hr's rule).
- **verify-foundation**: `withAttachments` pure parts — the fit of an
  image into the page, the Attachments page wording.

## Questions, with the defaults the build takes

1. **Who may attach to a quotation?** Default: whoever may edit it, plus
   anyone who may create sales orders (to file the PO).
2. **Print with attachments by default?** Default: yes; "Print without
   attachments" in the PDF button's menu and `?attachments=0`.
3. **Files that cannot be drawn** (Word, Excel): listed on the Attachments
   page, not converted. Converting Office files needs LibreOffice on the
   server, which the shared host should not get.
4. **Attachments added to the quotation after the order was raised**: stay
   on the quotation; added to the order by hand.
5. **Size**: the generic upload's limit (10 MB a file) stays; a merged
   paper is streamed, never kept.

## Effort (Opus 5.5)

Medium — one push, about two to three hours: `pdf-lib` added to
`api/package.json` and the lockfile (the registry is reachable from the
server; here by hand as html-to-image was), `shared/pdfAttachments.ts`
(~60 min), the two guards, the copy on order creation and the two routes
(~40 min), the two cards and the spacing (~15 min), the PDF button's menu
(~15 min), verify cases and CLAUDE.md (~45 min).
