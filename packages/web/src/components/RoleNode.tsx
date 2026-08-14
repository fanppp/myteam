import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const statusColors: Record<string, string> = {
  running: '#3b82f6',
  thinking: '#eab308',
  tool: '#f97316',
  done: '#22c55e',
  error: '#ef4444',
  pending: '#6c7086',
  stale: '#7f1d1d',
};

const statusIcons: Record<string, string> = {
  running: '▶',
  thinking: '💭',
  tool: '🔧',
  done: '✅',
  error: '❌',
  pending: '⏳',
  stale: '💀',
};

const statusLabels: Record<string, string> = {
  running: '运行中',
  thinking: '思考中',
  tool: '工具调用',
  done: '完成',
  error: '错误',
  pending: '等待中',
  stale: '超时',
};

function RoleNodeComponent({ data }: { data: any }) {
  const color = statusColors[data.status] ?? '#6c7086';
  const icon = statusIcons[data.status] ?? '⏳';
  const label = statusLabels[data.status] ?? data.status;
  const isPending = data.status === 'pending';
  const isRunning = data.status === 'running';
  const isThinking = data.status === 'thinking';
  const isActive = isRunning || isThinking;

  const contentLines = (data.content || '').split('\n');
  const hasContent = contentLines.length > 0 && contentLines[0] !== '';

  return (
    <div
      style={{
        padding: '0',
        borderRadius: '10px',
        border: `2px solid ${color}`,
        background: '#1e1e2e',
        color: '#cdd6f4',
        width: '340px',
        fontSize: '13px',
        opacity: isPending ? 0.5 : 1,
        boxShadow: isActive
          ? `0 0 16px ${color}88, 0 0 4px ${color}`
          : '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'all 0.3s ease',
        overflow: 'hidden',
        animation: isRunning ? 'nodeBlink 1.5s ease-in-out infinite' : 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#6366f1' }} />

      {/* 标题栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 14px',
          background: `${color}18`,
          borderBottom: `1px solid ${color}33`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>{icon}</span>
          <strong style={{ color: '#cdd6f4', fontSize: '14px' }}>{data.roleId}</strong>
          {data.cli && (
            <span style={{
              padding: '1px 6px',
              borderRadius: '4px',
              background: '#6366f122',
              color: '#818cf8',
              fontSize: '10px',
              fontWeight: 600,
            }}>
              {data.cli}
            </span>
          )}
          {data.teamStrengths && isPending && (
            <span style={{ color: '#6c7086', fontSize: '11px', marginLeft: '4px' }}>
              {data.teamStrengths}
            </span>
          )}
        </div>
        <span
          style={{
            padding: '2px 10px',
            borderRadius: '12px',
            background: `${color}22`,
            color,
            fontSize: '11px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {isActive && (
            <span
              style={{
                display: 'inline-block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: color,
                animation: 'pulse 0.8s infinite',
              }}
            />
          )}
          {label}
        </span>
      </div>

      {/* 工具调用栏 */}
      {data.toolName && (
        <div
          style={{
            padding: '6px 14px',
            background: '#f9731622',
            color: '#fb923c',
            fontSize: '12px',
            borderBottom: '1px solid #f9731633',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>🔧</span>
          <span style={{ fontWeight: 600 }}>{data.toolName}</span>
        </div>
      )}

      {/* 内容区域 */}
      {hasContent ? (
        <div
          className="nodrag nowheel"
          style={{
            maxHeight: '400px',
            overflow: 'auto',
            padding: '10px 14px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity: 0.9,
            userSelect: 'text',
            cursor: 'text',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contentLines.map((line: string, i: number) => {
            const isDecision = line.includes('```decision');
            const isThinkingBlock = line.startsWith('[思考]');
            return (
              <div
                key={i}
                style={{
                  color: isDecision
                    ? '#a5d6ff'
                    : isThinkingBlock
                      ? '#fab387'
                      : '#cdd6f4',
                  fontStyle: isThinkingBlock ? 'italic' : 'normal',
                  opacity: isDecision || isThinkingBlock ? 0.85 : 1,
                  padding: '1px 0',
                }}
              >
                {line || ' '}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            padding: '10px 14px',
            color: '#6c7086',
            fontSize: '12px',
            fontStyle: 'italic',
          }}
        >
          {isPending
            ? `等待执行${data.caution ? ' · ' + data.caution : ''}...`
            : isActive
              ? '正在思考...'
              : ''}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: '#6366f1' }} />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.3; transform: scale(0.8); }
        }
        @keyframes nodeBlink {
          0%, 100% { box-shadow: 0 0 12px ${color}66, 0 2px 8px rgba(0,0,0,0.3); }
          50% { box-shadow: 0 0 24px ${color}aa, 0 0 8px ${color}; }
        }
      `}</style>
    </div>
  );
}

export default memo(RoleNodeComponent);
