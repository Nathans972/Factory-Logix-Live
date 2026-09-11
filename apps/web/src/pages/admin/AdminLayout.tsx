// PLACEHOLDER layout — to be implemented (admin nav + <Outlet />).
import { Outlet } from "react-router-dom";
export function AdminLayout() {
  return <div className="shell"><main className="main"><Outlet /></main></div>;
}
