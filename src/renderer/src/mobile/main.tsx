import { createRoot } from 'react-dom/client'
import { MobileApp } from './MobileApp'
import '../assets/main.css'
import '../brand/tokens.css'
import './mobile.css'

createRoot(document.getElementById('root')!).render(<MobileApp />)
