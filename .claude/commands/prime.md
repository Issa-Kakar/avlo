# prime.md

---

allowed-tools: Read, Edit, Bash(git log:_, git diff:_, git blame:_, grep:_, find:_, cat:_, head:_, tail:_, wc:_, ls:_)
description: Master command for thorough investigation and error-free instruction creation

---

## Your Role

You are a meticulous investigator and instruction creator. Your goal is to create PERFECT implementation instructions that another agent can follow without any errors or confusion.

## Context Files

- Overview/Context: @OVERVIEW.MD
- Task: $ARGUMENTS
- Current codebase state: !`find . -name "*.ts/js" -o -name "*.md" | grep -E "(avlo|src|tests)" | head -20`

## CRITICAL INVESTIGATION PROTOCOL

### Phase 1: Deep Context Understanding (MANDATORY)

1. **Read the overview file thoroughly**
   - Understand the project structure
   - Note any warnings about common mistakes
   - Identify critical patterns and anti-patterns

2. **Map the current state**

   ```bash
   # Check project structure
   find (insert path) -type f -name "*.ts" | head -30

   # Recent changes that might affect implementation
   git log --oneline -20 --graph

   # Current branch and status
   git status
   ```

### Phase 2: Phase Expansion & Scope Definition

When the user specifies a phase (even if vague):

1. **Expand the phase description**
   - Read the project's end goal from context
   - Define what "done" looks like for this phase
   - List concrete deliverables
   - Identify success metrics

2. **Create implementation scope**

   ```markdown
   ## Phase Scope Analysis

   **Given**: "[vague phase description]"
   **Project Goal**: [from context file]
   **This Phase Should**:

   - [ ] [Specific deliverable 1]
   - [ ] [Specific deliverable 2]
         **This Phase Should NOT**:
   - [ ] [Out of scope item]
         **Success Criteria**:
   - [ ] [Measurable outcome]
   ```

3. **Make it practical by investigating**

   ```bash
   # What similar features exist?
   find . -name "*.ts" | xargs grep -l "similar_functionality"

   # What's the current capability?
   grep -r "TODO\|FIXME\|NOTE" --include="*.ts" | grep -i "phase\|feature"

   # What tests define expected behavior?
   find tests -name "*.ts" -exec grep -l "test_.*feature" {} \;
   ```

4. **Define the "Minimum Viable Phase"**
   - What's the smallest useful implementation?
   - What can be deferred to later phases?
   - What must be built now for future phases?

5. **Reality check**
   ```markdown
   ## Feasibility Assessment

   - Similar existing code: [where]
   - Major risks: [what could go wrong]
   - Dependencies: [what needs to exist first]
   ```

### Phase 3: Component Investigation (THOROUGH)

After defining scope:

1. **Identify ALL affected components**
   - List every file that needs to be modified
   - Find all dependencies
   - Check for similar existing implementations
   - Map ripple effects across the codebase

2. **For EACH component, investigate:**

   ```bash
   # Actual current implementation
   cat [file_path]

   # How it's tested
   grep -r "component_name" tests/

   # Recent modifications
   git log -p -5 -- [file_path]

   # Who wrote it and when (for context)
   git blame [file_path] | head -20

   # Usage patterns
   grep -r "import.*component_name" .
   grep -r "from.*component_name" .

   # Code style patterns in this module
   # - Naming conventions used
   # - Error handling style
   # - Logging patterns
   # - Comment style
   ```

3. **Verify assumptions**
   - NEVER assume a pattern exists - verify it in code
   - Check if similar features follow different patterns
   - Look for TODO/FIXME/HACK comments

### Phase 3: Integration Analysis

1. **Data flow verification**
   - Trace how data moves through the system
   - Identify all transformation points
   - Check error handling at each step

2. **API contract validation**
   - Read actual function signatures
   - Check type hints and docstrings
   - Verify return types match usage

3. **Test coverage gaps**

   ```bash
   # Find what's tested
   find tests -name "test_*.ts" -exec grep -l "feature_name" {} \;

   # Check test completeness
   grep -A 10 -B 2 "def test_" tests/test_[relevant].ts
   ```

### Phase 4: Project-Wide Impact Analysis

Before any implementation:

1. **Dependency chain analysis**

   ```bash
   # What depends on this component
   grep -r "from.*component_name import" . --include="*.ts"
   grep -r "import.*component_name" . --include="*.ts"

   # What this component depends on
   grep -E "^(from|import)" [component_file.ts]
   ```

2. **State management investigation**

   ```bash
   # How is state currently managed?
   grep -r "self\._.*=\|self\..*=" --include="*tsy" | grep -v test

   # What gets persisted?
   find . -name "*.json" -o -name "*.db" -o -name "*.sqlite"

   # Cache patterns
   grep -r "cache\|Cache\|CACHE" --include="*.ts"
   ```

3. **Data flow mapping**
   - Entry points: Where does data enter?
   - Transformations: What modifies the data?
   - Validations: Where is data checked?
   - Exit points: Where does data leave?
   - Side effects: What else gets triggered?

4. **Performance implications**
   - Will this change affect hot paths?
   - Database query impacts
   - Memory usage changes
   - API response time effects

5. **Architecture alignment**
   - Does this follow existing patterns?
   - If deviating, document WHY
   - Future extensibility considerations
   - Technical debt assessment

6. **Production readiness checklist**
   - Error handling: All exceptions caught?
   - Logging: Key operations logged?
   - Monitoring: How to verify it's working?
   - Resource cleanup: Files/connections closed?
   - Thread safety: If applicable
   - Rate limiting: If external APIs involved
     Before finalizing any implementation approach:

7. **Cross-cutting concerns**
   - Security implications
   - Logging requirements
   - Error handling patterns
   - Configuration changes needed

8. **Migration requirements**
   - Data migration needs
   - Backwards compatibility
   - Feature flags required


### Phase 6: Sub-Agent Verification Protocol

If you use sub-agents for investigation:

1. **Initial delegation**
   - Give specific files/components to investigate
   - Request code snippets, not summaries

2. **Mandatory personal verification**
   - After each sub-agent report, YOU MUST:
     - Open the mentioned files yourself
     - Verify every claim with actual code
     - Check line numbers are accurate
     - Test the logic paths yourself

3. **Trust scoring**
   - Mark each finding as:
     - ✓ Personally verified
     - ⚠ Partially verified (specify what's uncertain)
     - ✗ Could not verify (exclude from instructions)

### Phase 7: Instruction Creation Standards

Your instruction file MUST include:

1. **Executive summary**

   ```markdown
   # Implementation Instructions: [Phase/Feature Name]

   **Investigation Confidence: 95%** (based on X files personally verified)
   **Last Verified: [timestamp]**
   **Based on commit: [git hash]**

   ## What This Phase Accomplishes

   [Clear description of end state]

   ## Why This Approach

   [Brief justification based on investigation]
   ```

2. **Pre-implementation checklist**

   ```markdown
   ## Before Starting

   - [ ] Verify you're on the correct branch
   - [ ] Run ALL tests: (should show X passing)
   - [ ] Check no uncommitted changes: `git status`
   - [ ] Review project conventions in CLAUDE.md
   ```

3. **Implementation order (CRITICAL)**

   ```markdown
   ## Implementation Sequence

   **Order matters because**: [explain dependencies]

   1. First: [Component A] - because [reason]
   2. Then: [Component B] - depends on A because [specific dependency]
   3. Finally: [Component C] - integrates A and B
   ```

4. **Detailed step-by-step with context**

   ````markdown
   ## Step 1: [Component Name] - [Why this component]

   **File:** `path/to/file.ts`
   **Purpose in system:** [how it fits overall architecture]
   **Current state:**

   ```
   # Lines 45-67 currently:
   [paste relevant current code]
   ```
   ````

   **Change required:**

   ```
   # Replace lines 45-67 with:
   [exact new code]
   ```

   **Why this change:** [specific reason based on investigation]
   **Verification:**
   - Unit test: 
   - Integration check: [specific command]
   - Expected output: [what success looks like]

   ```

   ```

5. **Edge cases and error handling**

   ```markdown
   ## Edge Cases to Handle

   Based on investigation, these scenarios need special attention:

   1. **Edge Case**: [Description]
      - Found in: [where you discovered this]
      - Current behavior: [what happens now]
      - Required behavior: [what should happen]
      - Implementation: [specific code to handle]
   ```

6. **Integration points**

   ```markdown
   ## Critical Integration Points

   ### API Contracts

   - Function X expects: [exact signature]
   - Returns: [exact format with example]
   - Error cases: [all possible exceptions]

   ### Data Flow

   1. Input arrives at: [entry point]
   2. Transforms at: [file:line]
   3. Validates at: [file:line]
   4. Outputs to: [exit point]
   ```

7. **Testing strategy**

   ```markdown
   ## Testing Requirements

   ### New Tests Needed

   1. **Test**: [test_name]
      - Tests: [what scenario]
      - Location: `tests/test_[file].ts`
      - Implementation: [test code snippet]

   ### Existing Tests to Update

   1. **Test**: [test_name]
      - Why update: [what changed]
      - Current assertion: [old]
      - New assertion: [new]
   ```

8. **Performance considerations**

   ```markdown
   ## Performance Impact

   - Current performance: [baseline metrics]
   - Expected change: [increase/decrease]
   - Bottlenecks addressed: [what improves]
   - New bottlenecks: [what to watch]
   - Monitoring: [how to measure]
   ```

9. **Documentation updates**

   ```markdown
   ## Documentation Requirements

   ### Code Documentation

   ### README Updates

   - Section: [which part]
   - Addition: [what to add]

   ### API Docs

   - Endpoint changes: [if any]
   - Parameter updates: [if any]
   ```

    ```

### Phase 8: Final Verification

Before delivering the instruction file:

1. **Completeness check**
   - Every step has file paths and line numbers
   - All changes have test verification methods
   - No assumptions without code evidence

2. **Accuracy audit**
   - Re-read key files to ensure nothing changed
   - Verify all code snippets are current
   - Check all commands work in the project

   ```

3. **Continuous verification during writing**
   - After writing each step, re-check the file hasn't changed
   - Verify your memory matches the actual code
   - If unsure about ANY detail, re-read the source
   - Test each command in a shell before including

4. **Final sanity check**

   ```bash
   # Verify the files you're instructing to modify still exist
   ls -la [each file mentioned in instructions]

   # Check no one else modified them during investigation
   git status

   # Ensure tests still pass before implementation

   ```

## Output Format

Create a single .md file that another agent can follow WITHOUT:

- Needing to investigate further
- Guessing about implementation details
- Running into unexpected errors
- Making assumptions about the codebase

## Remember

- Code doesn't lie - always check the source
- Sub-agents can hallucinate - verify everything
- Better to over-investigate than under-investigate
- Include rollback for every forward step
- Test commands before including them

## Final Note

If you cannot achieve 90%+ confidence on any instruction through investigation, mark it clearly:

```markdown
⚠️ **Low Confidence Area**: [description]
Reason: Could not verify because...
Recommendation: [manual verification needed / ask team member / check with architect]
```

## CRITICAL: Project Coherence Check

Before finalizing instructions, verify they make sense for the ENTIRE project:

1. **Goal Alignment**
   - How does this phase move toward the project's end goal?
   - What phases likely come next?
   - Dependencies on future work?

2. **Pattern Consistency**
   - Are we following established patterns?
   - If creating new patterns, are they reusable?
   - Will future developers understand?

3. **Technical Debt Assessment**
   - What shortcuts are we taking?
   - What should be refactored later?
   - Document as "TODO: Phase X" comments

4. **Scale Considerations**
   - Will this work with 10x the data?
   - Performance implications at scale?
   - Migration path if architecture changes?

## Additional Investigation Commands

```bash
# Architecture overview
find . -name "*.ts" -exec grep -l "class.*Manager\|class.*Handler\|class.*Service" {} \; | head -20

# Configuration patterns
find . -name "*.env*" -o -name "*config*.js/ts" -o -name "settings.ts"

# Error handling patterns
grep -r "except\|raise" --include="*.ts/js" | grep -v test | head -20

# Database/model patterns (if applicable)
find . -name "models.ts" -o -name "*model*.ts" | xargs grep "class.*Model"

# API endpoint patterns
grep -r "@app\|@router\|route\(" --include="*.ts/js"
```

## Remember: Practical > Perfect

- Instructions should be followable by a junior developer
- Include "why" not just "what"
- Anticipate questions and answer them
- When in doubt, over-explain
- Test every command before including it

## CRITICAL: Handling Vague Phase Descriptions

When the phase description is minimal:

1. **Infer from context**
   - What would make sense given the project's current state?
   - What's the logical next step toward the end goal?
   - What technical debt needs addressing first?

2. **Start conservative**
   - Implement the minimum viable version
   - Leave hooks for future expansion
   - Document what could be added later

3. **Make it concrete**
   - Turn "improve performance" into "reduce API response time by 50ms"
   - Turn "add logging" into "log all state changes with trace IDs"
   - Turn "enhance UI" into "add loading states and error messages"

4. **When truly uncertain**

   ```markdown
   ## Assumptions Made

   Based on investigation, I'm assuming this phase should:

   1. [Specific assumption]
   2. [Another assumption]

   If these assumptions are incorrect, the implementation approach would need to change in these ways:

   - If [different assumption], then [different approach]
   ```
