/** UI text. English by default; pass your own (KO_UI is included). */
export interface UiWords {
  close: string; openInHost: string; findByName: string; waiting: string; approve: string; reject: string; name: string; gaps: string; actions: string;
  none: string; risky: string; on: string; off: string; reason: string; propose: string; cancel: string; ask: string; send: string; thinking: string;
  found: string; more: (n: number) => string; openScreen: string; menu: string; self: string; applied: string; rejected: string; failed: string; proposed: string;
}

export const UI: UiWords = {
  close: 'Close', openInHost: 'Open in host', findByName: 'Find by name', waiting: 'Waiting for approval', approve: 'Approve', reject: 'Reject',
  name: 'Name', gaps: 'Gaps', actions: 'Actions', none: 'Nothing here.', risky: 'cannot be undone', on: 'On', off: 'Off', reason: 'Reason (optional)',
  propose: 'Propose', cancel: 'Cancel', ask: 'Ask about anything in the graph', send: 'Send', thinking: 'Looking…', found: 'Found',
  more: (n) => `${n} more`, openScreen: 'Open screen', menu: 'Screens', self: 'Governance graph', applied: 'Applied', rejected: 'Rejected', failed: 'Failed',
  proposed: 'Proposed. It runs once approved.',
};

export const KO_UI: UiWords = {
  close: '닫기', openInHost: '제품에서 열기', findByName: '이름으로 찾기', waiting: '결재 대기', approve: '승인', reject: '반려',
  name: '이름', gaps: '통제 공백', actions: '조작', none: '해당 항목이 없습니다.', risky: '되돌릴 수 없음', on: '켜기', off: '끄기', reason: '사유(선택)',
  propose: '제안', cancel: '취소', ask: '그래프의 무엇이든 물어보세요', send: '보내기', thinking: '찾는 중…', found: '찾은 항목',
  more: (n) => `${n}개 더 보기`, openScreen: '관리 화면', menu: '관리 화면', self: '거버넌스 그래프', applied: '적용했습니다', rejected: '반려했습니다', failed: '실패했습니다',
  proposed: '제안했습니다. 승인하면 적용됩니다.',
};
