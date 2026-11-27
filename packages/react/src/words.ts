/** UI text. English by default; pass your own (KO_UI is included). */
export interface UiWords {
  close: string; openInHost: string; findByName: string; waiting: string; approve: string; reject: string; name: string; gaps: string; actions: string;
  none: string; risky: string; on: string; off: string; reason: string; propose: string; cancel: string; ask: string; send: string; thinking: string;
  found: string; more: (n: number) => string; openScreen: string; menu: string; self: string; applied: string; rejected: string; failed: string; proposed: string;
  /** Chat: apply a proposal, and the whole replies that mean yes or no to the open proposals of the last answer. */
  apply: string; yes: RegExp; no: RegExp; sayYes: string; dropped: string;
  state: { done: string; dropped: string; stale: string };
  /** Chat: one button under an answer that found control gaps but proposed nothing, and the question it sends. */
  fixIt: string; fixAsk: (gap: string) => string;
  /** Screen: actions on the screen itself, and the note when a screen has nothing to list. */
  screenActions: string; noList: string;
  /** Screen opened for an answer: widen to the whole screen, or back to the answer's rows. */
  wholeScreen: string; onlyAnswer: (n: number) => string;
}

export const UI: UiWords = {
  close: 'Close', openInHost: 'Open in host', findByName: 'Find by name', waiting: 'Waiting for approval', approve: 'Approve', reject: 'Reject',
  name: 'Name', gaps: 'Gaps', actions: 'Actions', none: 'Nothing here.', risky: 'cannot be undone', on: 'On', off: 'Off', reason: 'Reason (optional)',
  propose: 'Propose', cancel: 'Cancel', ask: 'Ask about anything in the graph', send: 'Send', thinking: 'Looking…', found: 'Found',
  more: (n) => `${n} more`, openScreen: 'Open screen', menu: 'Screens', self: 'Governance graph', applied: 'Applied', rejected: 'Rejected', failed: 'Failed',
  proposed: 'Proposed. It runs once approved.',
  apply: 'Apply', yes: /^\s*(yes|yep|ok(ay)?|sure|apply( it| them)?|do it|go ahead)\s*[.!]*\s*$/i, no: /^\s*(no|nope|cancel|never ?mind|don'?t|stop)\s*[.!]*\s*$/i,
  sayYes: 'Say "yes" to apply, "no" to drop, or tell me what to change.', dropped: 'Dropped. Nothing was changed.',
  state: { done: 'sent', dropped: 'dropped', stale: 'replaced by a newer answer' },
  fixIt: 'Fix it', fixAsk: (gap) => `Fix this: ${gap}`,
  screenActions: 'On this screen', noList: 'This screen has nothing to list. Its actions are above.',
  wholeScreen: 'Show the whole screen', onlyAnswer: (n) => `Only the answer (${n})`,
};

export const KO_UI: UiWords = {
  close: '닫기', openInHost: '제품에서 열기', findByName: '이름으로 찾기', waiting: '결재 대기', approve: '승인', reject: '반려',
  name: '이름', gaps: '통제 공백', actions: '조작', none: '해당 항목이 없습니다.', risky: '되돌릴 수 없음', on: '켜기', off: '끄기', reason: '사유(선택)',
  propose: '제안', cancel: '취소', ask: '그래프의 무엇이든 물어보세요', send: '보내기', thinking: '찾는 중…', found: '찾은 항목',
  more: (n) => `${n}개 더 보기`, openScreen: '관리 화면', menu: '관리 화면', self: '거버넌스 그래프', applied: '적용했습니다', rejected: '반려했습니다', failed: '실패했습니다',
  proposed: '제안했습니다. 승인하면 적용됩니다.',
  apply: '적용', yes: /^\s*(응|네|예|그래|좋아|적용(해|해 ?줘|해 ?주세요)?|진행(해|해 ?줘)?|ㅇㅇ|ok|yes)\s*[.!]*\s*$/i, no: /^\s*(아니(요|오)?|아뇨|취소(해|해 ?줘)?|됐어|하지 ?마|no)\s*[.!]*\s*$/i,
  sayYes: '「적용해」라고 하면 적용하고, 「취소」라고 하면 버립니다. 바꿀 값을 말해도 됩니다.', dropped: '버렸습니다. 바뀐 것은 없습니다.',
  state: { done: '보냄', dropped: '버림', stale: '새 답으로 바뀜' },
  fixIt: '조치하기', fixAsk: (gap) => `「${gap}」 고쳐 줘`,
  screenActions: '이 화면의 조작', noList: '이 화면에는 목록이 없습니다. 위의 조작을 쓸 수 있습니다.',
  wholeScreen: '이 화면 전체 보기', onlyAnswer: (n) => `대화 결과 ${n}개만`,
};
