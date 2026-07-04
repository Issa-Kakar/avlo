/**
 * Standard-SQL word lists — upstream `SQLKeywords` / `SQLTypes` from
 * @codemirror/lang-sql@6.10.0 (src/tokens.ts), MIT, verbatim (single-space
 * separated, no trailing space).
 *
 * ZERO imports on purpose: consumed by BOTH the vendored worker tokenizer
 * (`tokens.ts`, @lezer/lr graph) and the main-thread sync floor
 * (`code-tokenizer.ts`) — a shared pure-string module keeps the LR runtime out
 * of the main bundle while the two tokenizers classify from the same list.
 */

export const SQL_KEYWORDS =
  'absolute action add after all allocate alter and any are as asc assertion at authorization before begin between both breadth by call cascade cascaded case cast catalog check close collate collation column commit condition connect connection constraint constraints constructor continue corresponding count create cross cube current current_date current_default_transform_group current_transform_group_for_type current_path current_role current_time current_timestamp current_user cursor cycle data day deallocate declare default deferrable deferred delete depth deref desc describe descriptor deterministic diagnostics disconnect distinct do domain drop dynamic each else elseif end end-exec equals escape except exception exec execute exists exit external fetch first for foreign found from free full function general get global go goto grant group grouping handle having hold hour identity if immediate in indicator initially inner inout input insert intersect into is isolation join key language last lateral leading leave left level like limit local localtime localtimestamp locator loop map match method minute modifies module month names natural nesting new next no none not of old on only open option or order ordinality out outer output overlaps pad parameter partial path prepare preserve primary prior privileges procedure public read reads recursive redo ref references referencing relative release repeat resignal restrict result return returns revoke right role rollback rollup routine row rows savepoint schema scroll search second section select session session_user set sets signal similar size some space specific specifictype sql sqlexception sqlstate sqlwarning start state static system_user table temporary then timezone_hour timezone_minute to trailing transaction translation treat trigger under undo union unique unnest until update usage user using value values view when whenever where while with without work write year zone';

export const SQL_TYPES =
  'array binary bit boolean char character clob date decimal double float int integer interval large national nchar nclob numeric object precision real smallint time timestamp varchar varying';
