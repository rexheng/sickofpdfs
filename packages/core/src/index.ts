export type { DocumentId, LocationId, LocationKind, Sha256 } from './ids';
export type { Author, CommentId, MarkId, TabId, ThreadId } from './ids';
export { compareHlc, Hlc } from './hlc';
export type { HlcStamp } from './hlc';
export type { Anchor, CharPos, FigureFingerprint, NormRect, TextQuote } from './model/anchor';
export type { CommentMeta, CommentRow, MarkColor, MarkRow, MarkStyle, ThreadRow } from './model/rows';
export type { DocumentRow, LocationRow, PageHit, StoreStats } from './model/rows';
export type { AutoTagRemovedRow, ReadingTagRow, TagKind, TagRow, TagSource } from './model/rows';
export type { DetectedFigure, PageFigure } from './model/figures';
export type { SaveState } from './save/types';
export { reduceSave } from './save/save-machine';
export type { SaveEffect, SaveEvent } from './save/save-machine';
export type {
  CitableBlock, ClaudeReplyMeta, ClaudeStreamEvent, ClaudeTurnRequest, ClientTool, ConflictCopyMeta, ContextPack, DocumentMap, FigurePack,
  ModelChoice, ModelRole, PageCitation, Passage, RegionImage, ReplyError, WebSource,
} from './claude/types';
export { REPLY_ERROR_MESSAGES, replyError } from './claude/types';
export { CLIENT_TOOLS, EXPLAIN_FIGURE_QUESTION, MAX_WEB_SEARCHES, SYSTEM_PROMPT, describeToolUse } from './claude/prompts';
export { EFFORT, MAX_TOKENS, buildRequest, encodeRegionImage, figureLabelsOf, parseSearchSource, searchResultFor } from './claude/request';
export type { BuildOptions, MessageParam, MessagesParams, ThreadTurn } from './claude/request';
export { createStreamMapper, replyErrorFromApi } from './claude/stream-map';
export type { MapperOptions, ReplyResult, StreamMapper } from './claude/stream-map';
export { createCitationBook, replyBodyToPlainText } from './claude/citations';
export { KNOWN_LINES, LONG_PROMPT_TOKENS, USD_PER_WEB_SEARCH, priceFor, versionOf } from './claude/pricing';
export type { ModelPrice } from './claude/pricing';
export { CALIBRATION, EXPECTED_OUTPUT_TOKENS, FIXED_PROMPT_TOKENS, calibrationFor, decide, estimate, packTextTokens, typicalQuestionUsd, usdFromUsage } from './claude/cost';
export type { Ask, Decision, DecideInput, Estimate, UsageTokens } from './claude/cost';
export { createSha256, sha256Hex } from './identity/fingerprint';
export type { Sha256Hasher } from './identity/fingerprint';
export { canonicalLink, cleanLink } from './identity/canonical-link';
export { canonicalFileLocation, canonicalLocation, locationId } from './identity/location';
export { ALIAS_THRESHOLD, MIN_ALIAS_CHARS, MIN_ALIAS_CHARS_PER_PAGE, isStampAlias, stampedTextSimilarity, stripStamps } from './identity/stamps';
export * from './filter/index';
export { authorsFromInfo, extractMetadata } from './metadata/extract';
export type { ExtractedMetadata, MetadataInput } from './metadata/extract';
export { guessKind } from './metadata/kind';
export type { DocumentKind, KindInput } from './metadata/kind';
export { cleanTitle, isJunkTitle, titleFromFileName } from './metadata/titles';
export {
  BACKUP_DIR, BACKUP_FORMAT, BACKUP_VERSION, BackupFormatError, DUMP_TABLES, LIBRARY_PATH, MANIFEST_PATH, NOTES_DIR, PDF_DIR, SNAPSHOT_DIR, SNAPSHOT_KEEP, TOO_NEW_MESSAGE,
  buildManifest, countDump, describeBackup, emptyDump, emptyTables, isDraftRow, isSha, notesPath, parseLibraryDump, parseManifest, pathSegments, pdfPath, snapshotPath,
} from './backup/format';
export type {
  AliasRow, BackupCounts, BackupErrorCode, BackupManifest, DumpLocation, DumpTable, HistoryRow, LibraryDump, LibraryTables, ManifestInput, SettingRow,
} from './backup/format';
export { dayOf, parseSnapshotName, planSnapshots, snapshotName } from './backup/rotate';
export type { SnapshotPlan } from './backup/rotate';
export { isEmptyPlan, planRestore, planSize } from './backup/merge';
export type { CompareHlc, RestoreOptions, RestorePlan, RestoreSummary, TableCounts } from './backup/merge';
export { buildTextAnchor, QUOTE_CONTEXT } from './anchoring/quote';
export { DHASH_MATCH_MAX, dHash64, hammingHex } from './anchoring/dhash';
export { FUZZY_MIN_QUOTE, FUZZY_MIN_SCORE, resolveAnchor } from './anchoring/reanchor';
export type { AnchorContext, PlacedBy, Resolution, ResolveOptions } from './anchoring/reanchor';
export { planStyle } from './annotations/marks';
export type { StylePlan } from './annotations/marks';
export { CLAUDE_LABEL, SUBJ_BOLD, SUBJ_DOCUMENT_NOTE, SUBJ_PAGE_NOTE, SUBJ_THREAD, derivedId, parseNm, partNm, pdfRefOf, popupNm, rowNm } from './export/nm';
export type { NmPart, ParsedNm } from './export/nm';
export { commentPlainText, noteText, plainToMarkdown } from './export/note-text';
export type { NoteTextRefs } from './export/note-text';
export { MARKDOWN_FORMAT, exportMarkdown, notesFileName } from './export/markdown';
export type { ExportComment, ExportDocument, ExportMark, ExportThread } from './export/markdown-input';
export { ANNOT_FLAG, NOTE_ICON_SIZE, normToUser, planPdfExport, pointToUser, quadPoints, unionRect, userToNorm, userToPoint } from './export/pdf-mapping';
export type { NormRectsByPage, PageGeometry, PdfAnnotationPlan, PdfExportInput, PdfExportOptions, PdfExportPlan, PdfSubtype, PdfUserRect, Rgb } from './export/pdf-mapping';
export { nearestMarkColor, planPdfImport } from './export/pdf-import';
export type { ImportedMeta, ImportRef, PdfAnnotation, PdfImportOptions, PdfImportPlan } from './export/pdf-import';
export { findCourseCodes } from './categorise/course-codes';
export type { CourseCodeSource } from './categorise/course-codes';
export {
  ATTACH_SIMILARITY, MAX_SUGGESTIONS, MAX_TOPICS_PER_DOC, MERGE_SIMILARITY, MIN_TOPIC_SIZE, SUGGEST_SIMILARITY, TAG_MIN_DOCS, TOPIC_MIN_DOCS, clusterTopics, related, suggestTags, topicKey,
} from './categorise/topics';
export type { Doc, Topic } from './categorise/topics';
export { EMBEDDING_DIM, EMBEDDING_MODEL, MAX_ABSTRACT_CHARS, OPENING_PAGES, embeddingInput, withoutNames } from './categorise/text';
export type { EmbeddingInput, InputKind } from './categorise/text';
