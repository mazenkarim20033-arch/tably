import { BillPage } from './BillPage';
import { Brand } from './ui';

export function App() {
  const m = window.location.pathname.match(/^\/(?:s|bill)\/([\w-]+)\/?$/);
  if (m?.[1]) return <BillPage token={m[1]} />;
  return (
    <main className="page center">
      <Brand />
      <div className="empty">
        <h1>Split the bill, not the friendship.</h1>
        <p className="sub">Open the link a friend sent you to pick what you had and pay your share.</p>
      </div>
    </main>
  );
}
