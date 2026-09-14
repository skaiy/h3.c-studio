import { Routes, Route, Navigate } from 'react-router'
import { I18nProvider } from './lib/i18n'
import Workspace from './pages/Workspace'

export default function App() {
  return (
    <I18nProvider>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/b/:boardId" element={<Workspace />} />
        <Route path="/board" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </I18nProvider>
  )
}
