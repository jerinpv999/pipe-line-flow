export default function StatusBadge({ status }) {
  return (
    <span className={`badge badge-${status || 'unknown'}`}>
      <span className="badge-dot" />
      {status || 'never run'}
    </span>
  );
}
