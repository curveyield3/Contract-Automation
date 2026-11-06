import { classesForTriggersV1 } from './adr-taxonomy-v1.mjs';

const OPEN_REVIEWS = new Set(['GAP', 'CONTRADICTED', 'PENDING', 'NOT_ESTABLISHED']);
const OPEN_TESTS = new Set(['NOT_ACHIEVED', 'INCONCLUSIVE', 'PENDING']);
const TEST_STATUSES = new Set(['PASSED','PROPERTY_FAILED','NOT_APPLICABLE_CONFIRMED','INCONCLUSIVE','NOT_ACHIEVED','NOT_REQUIRED','PENDING']);

function statusFor(phase6Results, inventory, contextId, classId) {
  if (!phase6Results) return 'PENDING';
  const key = contextId + ':' + classId;
  const obligations = inventory.payload?.baselineObligations ?? phase6Results.baselineObligations ?? [];
  const matches = obligations.filter(o =>
    (o.contextId === contextId || (o.contextIds ?? []).includes(contextId)) && o.classId === classId);
  const fallback = phase6Results[key] ??
    phase6Results.byContextClass?.[contextId]?.[classId] ?? phase6Results.byContextClass?.[key];
  const normalize = value => {
    const status = typeof value === 'string' ? value : value?.testStatus ?? value?.status;
    return TEST_STATUSES.has(status) ? status : 'NOT_ACHIEVED';
  };
  if (!matches.length) return normalize(fallback);
  // Each matching obligation must be satisfied. A passing sibling cannot mask an
  // open, failed or unexecuted obligation on the same context and detection class.
  const statuses = matches.map(o => normalize(phase6Results[o.obligationId]));
  for (const status of ['PROPERTY_FAILED','NOT_ACHIEVED','INCONCLUSIVE','PENDING','NOT_REQUIRED'])
    if (statuses.includes(status)) return status === 'NOT_REQUIRED' ? 'NOT_ACHIEVED' : status;
  if (statuses.every(s => s === 'PASSED')) return 'PASSED';
  if (statuses.every(s => s === 'NOT_APPLICABLE_CONFIRMED')) return 'NOT_APPLICABLE_CONFIRMED';
  // Mixed PASS/N-A never proves the collective obligation.
  return 'NOT_ACHIEVED';
}

function summary(rows) {
  const stats = {contexts: new Set(), accepted:0, contradicted:0, notApplicableClaims:0, gaps:0, testsPassed:0, propertyFailures:0, notAchieved:0,
    classSupported:0, classConcerns:0, classUnresolved:0, classUnestablished:0};
  for (const row of rows) {
    stats.contexts.add(row.contextId);
    if (row.reviewStatus === 'ACCEPTED') stats.accepted++;
    if (row.reviewStatus === 'CONTRADICTED') stats.contradicted++;
    if (row.reviewStatus === 'NOT_APPLICABLE_CLAIMED') stats.notApplicableClaims++;
    if (row.reviewStatus === 'GAP') stats.gaps++;
    if (row.testStatus === 'PASSED') stats.testsPassed++;
    if (row.testStatus === 'PROPERTY_FAILED') stats.propertyFailures++;
    if (row.testStatus === 'NOT_ACHIEVED') stats.notAchieved++;
    if (row.classAssessmentOrigin === 'ACCEPTED_AI_AUTHORED') {
      if (row.classAssessment === 'SUPPORTED') stats.classSupported++;
      if (row.classAssessment === 'CONCERN') stats.classConcerns++;
      if (row.classAssessment === 'UNRESOLVED') stats.classUnresolved++;
    } else if (row.classAssessmentOrigin === 'NOT_ESTABLISHED') stats.classUnestablished++;
  }
  return {...stats, contexts:stats.contexts.size};
}

export function buildCoverageMatrixV1({inventory, taxonomy, discoveryState = null, phase6Results = null}) {
  const rows = [], byContract = {}, byClass = {};
  const v13 = discoveryState?.reviewPolicy === 'correctness-verdict-v13';
  const functionReviews = {};
  const verdictRows = v13 ? discoveryState?.functionVerdicts ?? {} : {};
  const trivialRefs = new Map();
  if (v13) for (const review of discoveryState?.trivialReviewSubstitutions ?? []) {
    if (review?.acceptedSubstitution !== true) continue;
    for (const id of Array.isArray(review.qualifiedContextIds) ? review.qualifiedContextIds : [])
      if (!trivialRefs.has(id)) trivialRefs.set(id, review.sourceReference ?? null);
  }
  const recordedGaps = discoveryState?.gaps ?? [];
  const gaps = new Set(recordedGaps.flatMap(x => typeof x === 'string' ? [x] : [x?.contextId,...(x?.contextIds??[])].filter(Boolean)));
  const contradictions = new Set((discoveryState?.attackContradictions ?? []).map(x => x.contextId + ':' + x.classId));
  const classes = new Map(taxonomy.classes.map(x => [x.classId, x]));
  const contexts = [...(inventory.payload?.contexts ?? [])].sort((a,b) =>
    a.path.localeCompare(b.path) || a.lineStart-b.lineStart || a.contextId.localeCompare(b.contextId));
  for (const ctx of contexts) {
    if (ctx.scopeTier && !['IN_SCOPE','INHERITED_DEPENDENCY'].includes(ctx.scopeTier)) continue;
    const contract = ctx.qualifiedContainer || ctx.effectiveIn?.[0] || ctx.path;
    if (v13) {
      // A function verdict and a qualified literal substitution are not
      // independent security-class assessments. Track each context once,
      // including those without taxonomy-triggered classes.
      const recorded = Object.hasOwn(verdictRows, ctx.contextId) ? verdictRows[ctx.contextId] : null;
      const explicitVerdict = ['CORRECT', 'DEFECT', 'UNRESOLVED'].includes(recorded?.verdict);
      const substitution = trivialRefs.has(ctx.contextId);
      functionReviews[ctx.contextId] = {
        status: explicitVerdict ? 'VERDICT_RECORDED' : substitution ? 'TRIVIAL_SUBSTITUTION' : 'NOT_RECORDED',
        verdict: explicitVerdict ? recorded.verdict : null,
        sourceReference: explicitVerdict ? recorded.sourceReference ?? null :
          substitution ? trivialRefs.get(ctx.contextId) : null
      };
    }
    for (const classId of classesForTriggersV1(taxonomy, inventory.payload?.triggers?.[ctx.contextId] ?? [])) {
      const assessment = discoveryState?.reviewChecks?.[ctx.contextId]?.[classId];
      // Do not manufacture class claims from verdicts, candidates, trivial
      // substitutions, contract-wide checks or a passing machine execution.
      const classAssessment = typeof assessment === 'string' ? assessment :
        assessment?.assessment ?? null;
      const classAssessmentOrigin = v13
        ? ['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE'].includes(classAssessment)
          ? 'ACCEPTED_AI_AUTHORED' : 'NOT_ESTABLISHED'
        : assessment === undefined || assessment === null
          ? 'NOT_ESTABLISHED' : 'LEGACY_ORIGIN_UNVERIFIED';
      let testStatus = classes.get(classId)?.testRequired === false ? 'NOT_REQUIRED' :
        statusFor(phase6Results, inventory, ctx.contextId, classId);
      let reviewStatus = !discoveryState ? 'PENDING' : gaps.has(ctx.contextId) ? 'GAP' :
        contradictions.has(ctx.contextId + ':' + classId) && testStatus !== 'PASSED' ? 'CONTRADICTED' :
        v13 && classAssessmentOrigin === 'NOT_ESTABLISHED' ? 'NOT_ESTABLISHED' :
        assessment === undefined || assessment === null ? 'PENDING' :
        assessment === 'UNRESOLVED' || assessment?.assessment === 'UNRESOLVED' ? 'GAP' :
        assessment === 'NOT_APPLICABLE' || assessment?.assessment === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE_CLAIMED' : 'ACCEPTED';
      rows.push({contextId:ctx.contextId,contract,classId,reviewStatus,testStatus,
        classAssessment:classAssessmentOrigin === 'NOT_ESTABLISHED' ? null : classAssessment,
        classAssessmentOrigin,
        ...(v13 ? {functionReviewStatus:functionReviews[ctx.contextId].status,
          functionVerdict:functionReviews[ctx.contextId].verdict} : {})
      });
    }
  }
  rows.sort((a,b) => a.contract.localeCompare(b.contract) || a.classId.localeCompare(b.classId) || a.contextId.localeCompare(b.contextId));
  for (const name of [...new Set(rows.map(x => x.contract))].sort())
    byContract[name] = summary(rows.filter(x => x.contract === name));
  for (const name of [...new Set(rows.map(x => x.classId))].sort())
    byClass[name] = summary(rows.filter(x => x.classId === name));
  // Missing inventory, zero reviewed classes and non-context review-plan gaps
  // are real coverage gaps; none may be reported as FULL_COVERAGE.
  const invalidInventory = inventory?.payload?.complete !== true || contexts.length === 0;
  const globalGaps = recordedGaps.filter(g => !g?.contextId && !(g?.contextIds?.length)).length;
  const gapCount = rows.filter(x => OPEN_REVIEWS.has(x.reviewStatus) || OPEN_TESTS.has(x.testStatus)).length +
    globalGaps + (invalidInventory ? 1 : 0) + (rows.length === 0 ? 1 : 0);
  const recordedFunctions = Object.values(functionReviews);
  const functionReviewSummary = v13 ? {
    requiredContexts:recordedFunctions.length,
    verdictRecorded:recordedFunctions.filter(x=>x.status==='VERDICT_RECORDED').length,
    trivialSubstitutions:recordedFunctions.filter(x=>x.status==='TRIVIAL_SUBSTITUTION').length,
    notRecorded:recordedFunctions.filter(x=>x.status==='NOT_RECORDED').length
  } : null;
  const classEvidenceSummary = v13 ? {
    requiredContextClassPairs:rows.length,
    supported:rows.filter(x=>x.classAssessment==='SUPPORTED'&&x.classAssessmentOrigin==='ACCEPTED_AI_AUTHORED').length,
    concerns:rows.filter(x=>x.classAssessment==='CONCERN'&&x.classAssessmentOrigin==='ACCEPTED_AI_AUTHORED').length,
    unresolved:rows.filter(x=>x.classAssessment==='UNRESOLVED'&&x.classAssessmentOrigin==='ACCEPTED_AI_AUTHORED').length,
    notApplicable:rows.filter(x=>x.classAssessment==='NOT_APPLICABLE'&&x.classAssessmentOrigin==='ACCEPTED_AI_AUTHORED').length,
    notEstablished:rows.filter(x=>x.classAssessmentOrigin==='NOT_ESTABLISHED').length
  } : null;
  return {rows, byContract, byClass, gapCount, label:gapCount ? 'PARTIAL_COVERAGE' : 'FULL_COVERAGE',
    // FULL_COVERAGE describes evidence bookkeeping, never universal safety.
    coverageMeaning:'EVIDENCE_COVERAGE_NOT_SECURITY_ASSURANCE',
    ...(v13 ? {functionReviews,functionReviewSummary,classEvidenceSummary} : {})
  };
}

export function renderCoverageMarkdownV1(matrix) {
  if (matrix.functionReviewSummary) {
    const f=matrix.functionReviewSummary,c=matrix.classEvidenceSummary;
    const lines=[
      'Function review and class-level evidence are reported independently.',
      'Function verdicts and literal substitutions do not establish every triggered security class.',
      '',
      'Function reviews: '+f.verdictRecorded+' explicit verdicts; '+
        f.trivialSubstitutions+' qualified literal substitutions; '+
        f.notRecorded+' not recorded; '+f.requiredContexts+' required contexts.',
      'Security-class assessments: '+c.supported+' SUPPORTED; '+c.concerns+
        ' CONCERN; '+c.unresolved+' UNRESOLVED; '+c.notApplicable+
        ' NOT_APPLICABLE; '+c.notEstablished+' not established; '+
        c.requiredContextClassPairs+' triggered context/class pairs.',
      '',
      '| Contract | Class | Contexts | Explicit supported | Explicit concerns | Explicit unresolved | Class unestablished | Tests passed | Property failures | Not achieved |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    ];
    for (const contract of Object.keys(matrix.byContract).sort()) {
      for (const classId of [...new Set(matrix.rows.filter(x=>x.contract === contract).map(x=>x.classId))].sort()) {
        const stats=summary(matrix.rows.filter(x=>x.contract===contract&&x.classId===classId));
        lines.push('| '+[contract,classId,stats.contexts,stats.classSupported,
          stats.classConcerns,stats.classUnresolved,stats.classUnestablished,
          stats.testsPassed,stats.propertyFailures,stats.notAchieved].join(' | ')+' |');
      }
    }
    lines.push('', '**Evidence coverage: '+matrix.label+'**',
      'Missing class assessments are evidence-reporting states, not new execution blockers.',
      'Machine test results describe bounded execution observations, not universal safety guarantees.');
    return lines.join('\n')+'\n';
  }
  const headings = '| Contract | Class | Contexts | Accepted | Contradicted | Not-applicable claims | Gaps | Tests passed | Property failures | Not achieved |';
  const separator = '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const lines = [headings, separator];
  for (const contract of Object.keys(matrix.byContract).sort()) {
    for (const classId of [...new Set(matrix.rows.filter(x=>x.contract === contract).map(x=>x.classId))].sort()) {
      const s = summary(matrix.rows.filter(x => x.contract===contract && x.classId===classId));
      lines.push('| ' + [contract,classId,s.contexts,s.accepted,s.contradicted,s.notApplicableClaims,s.gaps,s.testsPassed,s.propertyFailures,s.notAchieved].join(' | ') + ' |');
    }
  }
  lines.push('', '**Assurance: ' + matrix.label + '**');
  return lines.join('\n') + '\n';
}
