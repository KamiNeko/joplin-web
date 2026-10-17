import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { LoginForm } from "@/components/auth/LoginForm";
import { ThemeToggle } from "@/components/common/ThemeToggle";

export function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate("/notes", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center p-4 overflow-hidden bg-gradient-to-br from-[#060a16] via-[#0d1428] to-[#161233]">
      {/* Background radial glow effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[550px] bg-primary/15 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-indigo-600/10 rounded-full blur-[120px] pointer-events-none" />

      {/* Top right theme toggle */}
      <div className="absolute top-5 right-5 z-20">
        <ThemeToggle className="bg-card/40 backdrop-blur-sm border border-border/40" />
      </div>

      <div className="relative z-10 w-full max-w-md animate-in fade-in-50 zoom-in-95 duration-300">
        <LoginForm onSuccess={() => navigate("/notes", { replace: true })} />
      </div>

      {/* Subtle footer */}
      <div className="absolute bottom-4 text-xs text-muted-foreground/60 text-center w-full select-none">
        Joplin Web &bull; Fast, Secure, Markdown Notes
      </div>
    </div>
  );
}
