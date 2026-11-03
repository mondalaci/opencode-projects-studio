import type { AssistantToolBlock } from "@/api/types"

/** A reply typed into a question, ready to stand as a message of its own. */
export interface QuestionReply {
  /** Stable id derived from the tool call it answers, so it never duplicates. */
  id: string
  text: string
  /** When the answer was given, read off the tool's own clock. */
  at: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/** The labels and values a question's answer is compared against. */
function optionChoices(question: Record<string, unknown>): Set<string> {
  const choices = new Set<string>()
  const options = question.options
  if (!Array.isArray(options)) return choices
  for (const option of options) {
    const record = asRecord(option)
    if (!record) continue
    if (typeof record.label === "string") choices.add(record.label)
    if (typeof record.value === "string") choices.add(record.value)
  }
  return choices
}

function questionsOf(input: Record<string, unknown>): Record<string, unknown>[] {
  const questions = input.questions
  if (!Array.isArray(questions)) return []
  return questions.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
}

/**
 * The free-form replies a completed `question` tool call carries.
 *
 * A question is answered either by picking one of its options or by typing an
 * answer, and the server records both the same way: an array of values per
 * question, in the tool's own `metadata.answers`. The options are already shown
 * by the card that offered them, and their values read back as the option's own
 * label rather than as anything the person wrote, so only the values that match
 * no option are returned. Those are the replies that belong in the conversation
 * as messages of the person's own; the question tool card keeps the record.
 */
export function questionReplies(block: AssistantToolBlock): QuestionReply[] {
  if (block.name !== "question" || block.state.status !== "completed") return []
  const answers = block.state.metadata?.answers
  if (!Array.isArray(answers)) return []
  const questions = questionsOf(block.state.input)
  const replies: QuestionReply[] = []
  questions.forEach((question, index) => {
    const values = answers[index]
    if (!Array.isArray(values)) return
    const choices = optionChoices(question)
    const typed = values
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .filter((value) => !choices.has(value))
    if (!typed.length) return
    replies.push({
      id: `answer-${block.id}-${index}`,
      text: typed.join("\n"),
      at: block.time.completed ?? block.time.created,
    })
  })
  return replies
}
