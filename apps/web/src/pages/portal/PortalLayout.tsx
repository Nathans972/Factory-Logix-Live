// PLACEHOLDER layout — to be implemented (sidebar nav + <Outlet />).
import { Outlet } from "react-router-dom";
export function PortalLayout() {
  return <div className="shell"><main className="main"><Outlet /></main></div>;
}
