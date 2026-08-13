import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function StartNodeComponent({ data }: { data: { content: string } }) {
  return (
    <div
      style={{
        width: '340px',
        overflow: 'hidden',
        border: '2px solid #a855f7',
        borderRadius: '10px',
        background: '#1e1e2e',
        color: '#cdd6f4',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          background: '#a855f718',
          borderBottom: '1px solid #a855f733',
          fontSize: '14px',
        }}
      >
        <span style={{ fontSize: '16px' }}>Request</span>
        <strong>请求</strong>
      </div>
      <div
        className="nodrag nowheel"
        style={{
          maxHeight: '400px',
          overflow: 'auto',
          padding: '10px 14px',
          fontSize: '13px',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
          cursor: 'text',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {data.content}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#a855f7' }} />
    </div>
  );
}

export default memo(StartNodeComponent);
