import { useEffect } from "react";
import { getDesktopAppBinding } from "@/services/desktop-runtime";

export function useSkillInstallLinkBootstrap() {
    useEffect(() => {
        let active = true;
        const take = () =>
            getDesktopAppBinding()
                ?.ConsumeSkillInstallLink?.()
                .then((to) => {
                    if (active && to.startsWith("/skills?install=")) window.dispatchEvent(new CustomEvent("workspace:navigate", { detail: { to } }));
                })
                .catch(() => {
                    /* The same website link can be pasted on the market page. */
                });
        void take();
        const timer = window.setInterval(() => void take(), 1500);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, []);
}
