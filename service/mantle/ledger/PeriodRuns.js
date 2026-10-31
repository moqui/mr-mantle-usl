// The period-run contract (PeriodRunServices): a kind of period calculation (PeriodRunKind: its calculation service in
// enumCode, its posting service in optionValue) previewed into an AccountingPeriodRun with one AccountingPeriodRunResult per
// source, then posted by its kind once the results are unchanged. A failed source is a failed result; the others stand.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, call, display, denied} = lib
const RUN = "mantle.ledger.transaction.AccountingPeriodRun",
    RESULT = "mantle.ledger.transaction.AccountingPeriodRunResult"

function kindOf(runKindEnumId) {
    const kind = runKindEnumId && one("moqui.basic.Enumeration", {enumId: runKindEnumId, enumTypeId: "PeriodRunKind"})
    if (!kind || !kind.enumCode) denied("RUN_KIND_INVALID", "Choose a kind of period run")
    return kind
}
// The organization's own open period, and the run's book day within it (default its last day).
function openPeriod(s, timePeriodId, effectiveDate, lock = false) {
    if (!timePeriodId) denied("PERIOD_REQUIRED", "Choose a fiscal period")
    const found = lib.record({kind: "periods", recordId: timePeriodId, organizationPartyId: s.organizationPartyId})
    if (found.partyId !== s.organizationPartyId) denied("PERIOD_UNAVAILABLE", "Choose a fiscal period of this organization")
    const period = lock ? find("mantle.party.time.TimePeriod", {timePeriodId}).forUpdate(true).one() : found
    if (period.isClosed === "Y") denied("PERIOD_CLOSED", "The period is closed")
    const fromDay = lib.calendarDateText(period.fromDate),
        thruDay = lib.calendarDateText(period.thruDate)
    const day = effectiveDate ? lib.calendarDateText(effectiveDate) : thruDay
    if (day < fromDay || day > thruDay) denied("RUN_DATE_INVALID", "Choose a day within the period")
    return {period, day}
}
// The kind's results for the request, failure-tolerant: a calculation that fails is one failed result.
function calculate(kind, s, period, day, sourceIdList) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(kind.enumCode)
                .parameters({
                    organizationPartyId: s.organizationPartyId,
                    timePeriodId: period.timePeriodId,
                    effectiveDate: day,
                    sourceIdList
                })
                .disableAuthz()
                .call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return Array.from(out.results || []).map(row => Object.assign({}, row))
    } catch (error) {
        ec.logger.error("Period run " + kind.enumId + " of " + period.timePeriodId + ": " + error.message)
        return [{description: kind.description, failureCode: "CALCULATION_FAILED", failureMessage: String(error.message)}]
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const versionOf = results =>
    lib.hash(
        results.map(r => [r.sourceEntityName, r.sourceId, r.amount == null ? null : String(r.amount), r.failureCode || null])
    )

function preview(p) {
    const s = lib.organization(p, "glPost")
    const kind = kindOf(p.runKindEnumId)
    const {period, day} = openPeriod(s, p.timePeriodId, p.effectiveDate)
    const sourceIdList = p.sourceIdList ? Array.from(p.sourceIdList) : []
    const results = calculate(kind, s, period, day, sourceIdList)
    const failed = results.filter(r => r.failureCode)
    const total = results.filter(r => !r.failureCode).reduce((sum, r) => sum.add(toDecimal(r.amount ?? 0)), toDecimal(0))
    const run = call("create#" + RUN, {
        runKindEnumId: kind.enumId,
        organizationPartyId: s.organizationPartyId,
        timePeriodId: period.timePeriodId,
        effectiveDate: day,
        currencyUomId: lib.preference(s.organizationPartyId).baseCurrencyUomId,
        statusId: failed.length && failed.length === results.length ? "PrnFailed" : "PrnPreview",
        calculationVersion: versionOf(results),
        sourceSelectionJson: sourceIdList.length ? JSON.stringify(sourceIdList) : null,
        totalAmount: total,
        resultCount: results.length,
        failedCount: failed.length,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    results.forEach((r, index) =>
        call("create#" + RESULT, {
            periodRunId: run.periodRunId,
            resultSeqId: String(index + 1).padStart(5, "0"),
            sourceEntityName: r.sourceEntityName || null,
            sourceId: r.sourceId || null,
            description: r.description || null,
            amount: r.amount == null ? null : toDecimal(r.amount),
            debitGlAccountId: r.debitGlAccountId || null,
            creditGlAccountId: r.creditGlAccountId || null,
            statusId: r.failureCode ? "PrrFailed" : "PrrReady",
            failureCode: r.failureCode || null,
            failureMessage: r.failureMessage || null
        })
    )
    // a recalculation supersedes the earlier previews of the same kind, organization and period
    for (const old of rows(RUN, {
        runKindEnumId: kind.enumId,
        organizationPartyId: s.organizationPartyId,
        timePeriodId: period.timePeriodId,
        statusId: "PrnPreview"
    }))
        if (old.periodRunId !== run.periodRunId)
            call("update#" + RUN, {periodRunId: old.periodRunId, statusId: "PrnSuperseded", supersededByRunId: run.periodRunId})
    const created = one(RUN, {periodRunId: run.periodRunId})
    return {
        periodRunId: run.periodRunId,
        calculationVersion: created.calculationVersion,
        resultCount: results.length,
        failedCount: failed.length,
        totalAmount: total
    }
}

// A run the user may read, with its kind's name and its results.
function get(p) {
    const run = p.periodRunId && one(RUN, {periodRunId: p.periodRunId})
    if (!run) denied("RUN_UNAVAILABLE", "The period run is not available")
    const s = lib.organization({organizationPartyId: run.organizationPartyId}, "read")
    if (!s.capabilities.glPost && !s.capabilities.reportRead && !s.capabilities.admin)
        denied("PERMISSION_DENIED", "Accounting read authority is required")
    const kind = one("moqui.basic.Enumeration", {enumId: run.runKindEnumId})
    const period = one("mantle.party.time.TimePeriod", {timePeriodId: run.timePeriodId})
    const statusText = id => one("moqui.basic.StatusItem", {statusId: id})?.description || id
    return {
        run: Object.assign(display(run), {
            kindText: kind?.description || run.runKindEnumId,
            periodText: period?.periodName || run.timePeriodId,
            statusText: statusText(run.statusId),
            canPost: run.statusId === "PrnPreview" && !!s.capabilities.glPost && period?.isClosed !== "Y"
        }),
        results: Array.from(find(RESULT, {periodRunId: run.periodRunId}).orderBy("resultSeqId").list()).map(r =>
            Object.assign(display(r), {statusText: statusText(r.statusId)})
        )
    }
}

// Post a previewed run: under the run's and period's locks, its kind calculates again and the results must be the same
// version the user reviewed (RUN_CHANGED otherwise); its kind's posting service posts the ready results. A retry with the
// same operation key answers the first post.
function post(p) {
    const initial = p.periodRunId && one(RUN, {periodRunId: p.periodRunId})
    if (!initial) denied("RUN_UNAVAILABLE", "The period run is not available")
    const s = lib.organization({organizationPartyId: initial.organizationPartyId}, "glPost")
    const op = lib.lib.operation(p, "PeriodRunPost", s.organizationPartyId, {
        periodRunId: initial.periodRunId,
        calculationVersion: p.calculationVersion
    })
    if (op.old) return lib.lib.previous(op)
    // only the run is locked here: each result posts in its own transaction (define#RunPosting), which takes the
    // organization's and the period's posting locks itself
    const run = find(RUN, {periodRunId: initial.periodRunId}).forUpdate(true).one()
    if (run.statusId !== "PrnPreview") denied("RUN_NOT_PREVIEW", "Only a previewed run is posted")
    if (run.calculationVersion !== p.calculationVersion) denied("RUN_CHANGED", "The run changed; review it again")
    const kind = kindOf(run.runKindEnumId)
    if (!kind.optionValue) denied("RUN_KIND_INVALID", "This kind of run is not posted here")
    const {period, day} = openPeriod(s, run.timePeriodId, run.effectiveDate)
    const sourceIdList = lib.lib.json(run.sourceSelectionJson, [])
    if (versionOf(calculate(kind, s, period, day, sourceIdList)) !== run.calculationVersion)
        denied("RUN_CHANGED", "The sources changed since the preview; recalculate the run")
    const out = call(kind.optionValue, {periodRunId: run.periodRunId})
    const postedCount = Number(out.postedCount || 0),
        failedCount = Number(out.failedCount || 0)
    const statusId = !postedCount ? "PrnFailed" : failedCount ? "PrnPartial" : "PrnPosted"
    call("update#" + RUN, {
        periodRunId: run.periodRunId,
        statusId,
        postedByUserId: ec.user.userId,
        postedDate: ec.user.nowTimestamp,
        failedCount: failedCount + Number(run.failedCount || 0)
    })
    const answer = {periodRunId: run.periodRunId, statusId, postedCount, failedCount}
    lib.lib.complete(op, RUN, run.periodRunId, answer)
    return answer
}

const operations = {preview, get, post}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown period run operation " + op)
        return operations[op](parameters)
    }
})
