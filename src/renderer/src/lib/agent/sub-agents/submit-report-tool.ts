import type { ToolDefinition } from '../../api/types'
import type { ToolHandler } from '../../tools/tool-types'

export const SUBMIT_REPORT_TOOL_NAME = 'SubmitReport'

const submittedReportsByRunId = new Map<string, string>()

function readSubmittedReport(input: Record<string, unknown>): string {
  const raw = (input as { report?: unknown }).report
  return typeof raw === 'string' ? raw.trim() : ''
}

export function submitReportForRun(
  runId: string | undefined,
  input: Record<string, unknown>
): { success: boolean; report?: string; error?: string } {
  const report = readSubmittedReport(input)
  if (!report) {
    return {
      success: false,
      error:
        'SubmitReport rejected: the `report` argument was empty. ' +
        'Call SubmitReport again with the full report body — do not call any other tools first.'
    }
  }

  if (runId && !submittedReportsByRunId.has(runId)) {
    submittedReportsByRunId.set(runId, report)
  }

  return { success: true, report }
}

export function getSubmittedReportForRun(runId: string | undefined): string | null {
  if (!runId) return null
  return submittedReportsByRunId.get(runId) ?? null
}

export function clearSubmittedReportForRun(runId: string | undefined): void {
  if (!runId) return
  submittedReportsByRunId.delete(runId)
}

/**
 * Build a per-run {@link ToolHandler} + {@link ToolDefinition} pair that lets a
 * sub-agent terminate its own loop by writing its final report.
 *
 * The caller wires the definition into the sub-agent's tool list and the
 * handler into {@link ToolContext.inlineToolHandlers}. When the model calls
 * `SubmitReport`, the handler stashes the `report` string into a closure and
 * returns an acknowledgement. The sub-agent runner then inspects
 * {@link createSubmitReportTool.getReport} after each iteration and stops the
 * loop once a report has been submitted.
 *
 * This gives sub-agents a clean, explicit "done" signal instead of relying on
 * the model to just stop emitting tool calls — which some models do unreliably,
 * leading to runaway loops after a report is already written.
 */
export function createSubmitReportTool(runId?: string): {
  name: string
  definition: ToolDefinition
  handler: ToolHandler
  getReport: () => string | null
} {
  let submitted: string | null = null

  const definition: ToolDefinition = {
    name: SUBMIT_REPORT_TOOL_NAME,
    description:
      'Submit your final work report and end this sub-agent session. ' +
      'You MUST call this tool exactly once when you have finished the task — ' +
      'the session terminates immediately after the call. ' +
      'Do not call any other tools after SubmitReport. ' +
      'Put the full report body (conclusion, findings, evidence, next steps) ' +
      'into the `report` argument as plain text in the same language as the ' +
      "user's request. An empty report is not acceptable.",
    inputSchema: {
      type: 'object',
      properties: {
        report: {
          type: 'string',
          description:
            'The complete final report body. Must be non-empty, in the same ' +
            "language as the user's request, and contain every finding, " +
            'conclusion, and recommendation the caller needs to understand ' +
            'what you did.'
        }
      },
      required: ['report']
    }
  }

  const handler: ToolHandler = {
    definition,
    execute: async (input) => {
      const result = submitReportForRun(runId, input)
      if (!result.success) {
        return result.error ?? 'SubmitReport rejected: invalid report payload.'
      }
      // First valid submission wins; later calls are ignored but still ack'd
      // so the loop can terminate cleanly on the next iteration boundary.
      if (submitted === null) {
        submitted = result.report ?? null
      }
      return 'Report submitted. This sub-agent session will now terminate.'
    }
  }

  return {
    name: SUBMIT_REPORT_TOOL_NAME,
    definition,
    handler,
    getReport: () => submitted ?? getSubmittedReportForRun(runId)
  }
}
