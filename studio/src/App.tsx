import { Routes, Route } from 'react-router'
import { I18nProvider } from './lib/i18n'
import Home from './pages/Home'
import BoardPage from './pages/Board'

export default function App() {
  return (
    <I18nProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/board" element={<BoardPage />} />
      </Routes>
    </I18nProvider>
  )
}
