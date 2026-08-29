export function defaultAnswers(questions: ReadonlyArray<{ options: ReadonlyArray<{ label: string }> }>) {
  return questions.map((question) => {
    const first = question.options[0]
    return first ? [first.label] : []
  })
}
